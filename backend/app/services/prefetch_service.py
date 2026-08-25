"""后台预加载 worker：并行填充 ready 窗口，减少工作台等待。

关键设计：
- 并行模型调用（受 asyncio.Semaphore 控制），串行不满足 2-3秒/张消费速率
- 水位控制：低于低水位全速补，达到高水位暂停
- asyncio.Event 即时唤醒（上传/消费/跳过后通知）
- failed 任务指数退避重试，不永久阻塞
- 状态完全持久化，Docker 重启后恢复
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy.orm import Session

from app.config import settings
from app.database import SessionLocal
from app.models import (
    MATERIAL_STATUS_PENDING,
    MaterialBatch,
    MaterialItem,
    MaterialPrefetchResult,
    PREFETCH_STATUS_FAILED,
    PREFETCH_STATUS_QUEUED,
    PREFETCH_STATUS_READY,
    PREFETCH_STATUS_RUNNING,
    ROLE_ADMIN,
    User,
)
from app.services import recognition_service
from app.services.recognition_telemetry import Telemetry
from app.services.resource_scheduler import get_scheduler

logger = logging.getLogger(__name__)

# 全局 worker 单例
_global_worker: PrefetchWorker | None = None
_active_owners: dict[int, float] = {}
_ACTIVE_OWNER_TTL_SECONDS = 90.0


def activate_owner(owner_id: int) -> None:
    """Mark an owner as actively using the classic workbench."""
    _active_owners[owner_id] = time.monotonic() + _ACTIVE_OWNER_TTL_SECONDS
    notify_worker()


def deactivate_owner(owner_id: int) -> None:
    _active_owners.pop(owner_id, None)


def _active_owner_ids() -> list[int]:
    now = time.monotonic()
    expired = [owner_id for owner_id, deadline in _active_owners.items() if deadline <= now]
    for owner_id in expired:
        _active_owners.pop(owner_id, None)
    return list(_active_owners)


def compute_config_fingerprint(
    base_url: str,
    model_name: str,
    recognition_prompt: str,
    rotation_degrees: int = 0,
) -> str:
    """计算配置指纹，用于检测模型/提示词变化后缓存失效。"""
    raw = (
        f"{base_url}|{model_name}|{recognition_prompt}|{rotation_degrees}|"
        f"ocr={settings.ocr_enabled}|ocr_min={settings.ocr_min_confidence}|"
        f"image_edge={settings.image_max_long_edge}|"
        f"jpeg_quality={settings.image_jpeg_quality}|ocr-v1"
    )
    return hashlib.md5(raw.encode("utf-8")).hexdigest()


def _get_current_fingerprint() -> str | None:
    """读取当前数据库中的配置指纹，未配置模型时返回 None。"""
    from app.routers.settings import _get_or_create_settings

    db = SessionLocal()
    try:
        s = _get_or_create_settings(db)
        if not s.base_url or not s.api_key or not s.model_name:
            return None
        prompt = recognition_service._load_recognition_prompt(db)
        return compute_config_fingerprint(s.base_url, s.model_name, prompt)
    finally:
        db.close()


def _commit_with_retry(db: Session, label: str) -> bool:
    """后台预加载专用提交:SQLite 锁冲突时按退避序列重试。

    与 db_retry.run_write_with_retry 的区别:最终仍失败时**不抛异常**,
    回滚并返回 False——后台任务的修改都有状态 filter 守卫(幂等),
    本周期安全跳过即可,下一轮 worker 周期天然重试,不需要 503。
    """
    from sqlalchemy.exc import OperationalError

    from app.db_retry import is_locked_error

    for delay_ms in settings.sqlite_lock_retry_delays_ms:
        try:
            db.commit()
            return True
        except OperationalError as exc:
            if not is_locked_error(exc):
                raise
            db.rollback()
            time.sleep(delay_ms / 1000.0)
    try:
        db.commit()
        return True
    except OperationalError as exc:
        if not is_locked_error(exc):
            raise
        db.rollback()
        logger.warning("预加载提交持续锁冲突,跳过本周期: %s", label)
        return False


class PrefetchWorker:
    """后台并行预加载 worker。

    - asyncio task + Semaphore 控制并发
    - 水位控制：ready < low 全速补充，>= high 暂停
    - asyncio.Event 即时唤醒
    - failed 指数退避重试
    - 状态持久化，重启可恢复
    """

    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._stop_event = asyncio.Event()
        self._wakeup_event = asyncio.Event()
        self._semaphore: asyncio.Semaphore | None = None
        self._last_batch_id: int = 0
        self._scheduler = get_scheduler()
        self._started_at: float = time.monotonic()
        # v1.3.10 任务注册表:pf_id -> 在途 asyncio.Task,供前台接管时取消
        self._tasks: dict[int, asyncio.Task] = {}

    async def start(self) -> None:
        global _global_worker
        if self._task is not None:
            return
        self._recover_stale_running()
        self._semaphore = asyncio.Semaphore(settings.material_prefetch_concurrency)
        self._started_at = time.monotonic()
        _global_worker = self
        self._task = asyncio.create_task(self._run_loop())

    async def stop(self) -> None:
        global _global_worker
        self._stop_event.set()
        self._wakeup_event.set()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        _global_worker = None
        self._stop_event.clear()
        self._wakeup_event.clear()

    def notify(self) -> None:
        """通知 worker 立即检查窗口（上传/消费/跳过后调用）。"""
        self._wakeup_event.set()

    # ============================================================
    # 启动恢复
    # ============================================================

    def _recover_stale_running(self) -> None:
        """重启后把遗留的 running/queued 任务重置为 queued，等待重新调度。"""
        db = SessionLocal()
        try:
            db.query(MaterialPrefetchResult).filter(
                MaterialPrefetchResult.status.in_([PREFETCH_STATUS_RUNNING, PREFETCH_STATUS_QUEUED]),
            ).update(
                {
                    "status": PREFETCH_STATUS_QUEUED,
                    "next_retry_at": None,
                },
                synchronize_session=False,
            )
            _commit_with_retry(db, "recover-stale-running")
        finally:
            db.close()

    # ============================================================
    # 主循环
    # ============================================================

    async def _run_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                # 重启恢复冷却:避免容器重启瞬间恢复全部任务造成资源/锁峰值。
                # 冷却期内 worker 仍然响应停止与唤醒日志,但不领取新任务。
                since_start = time.monotonic() - self._started_at
                cooldown = settings.material_prefetch_recovery_cooldown_seconds
                if cooldown <= 0 or since_start >= cooldown:
                    await self._fill_window()
                else:
                    self._wakeup_event.clear()
                    try:
                        await asyncio.wait_for(
                            self._wakeup_event.wait(),
                            timeout=min(cooldown - since_start, settings.material_prefetch_interval),
                        )
                    except asyncio.TimeoutError:
                        pass
            except Exception:
                logger.exception("预加载 worker 异常")
            self._wakeup_event.clear()
            try:
                await asyncio.wait_for(
                    self._wakeup_event.wait(),
                    timeout=settings.material_prefetch_interval,
                )
            except asyncio.TimeoutError:
                pass  # 正常超时，继续下一轮

    async def _fill_window(self) -> None:
        """检查并并行填充预加载窗口。"""
        active_owner_ids = _active_owner_ids()
        if not active_owner_ids:
            return
        fingerprint = _get_current_fingerprint()
        if fingerprint is None:
            self._clear_all()
            return

        db = SessionLocal()
        try:
            batches = (
                db.query(MaterialBatch)
                .join(User, User.id == MaterialBatch.owner_id)
                .filter(MaterialBatch.is_active.is_(True))
                .filter(MaterialBatch.owner_id.in_(active_owner_ids))
                .filter(User.is_active.is_(True))
                .filter(
                    (User.role == ROLE_ADMIN)
                    | (User.workflow_quota.is_(None))
                    | (
                        User.workflow_reserved + User.workflow_charged
                        < User.workflow_quota
                    )
                )
                .order_by(MaterialBatch.id.asc())
                .all()
            )
            if not batches:
                return
            batch = next(
                (candidate for candidate in batches if candidate.id > self._last_batch_id),
                batches[0],
            )
            self._last_batch_id = batch.id
            owner = db.get(User, batch.owner_id)
            if owner is None:
                return

            # 清理指纹不匹配的旧结果
            stale = (
                db.query(MaterialPrefetchResult)
                .filter(
                    MaterialPrefetchResult.batch_id == batch.id,
                    MaterialPrefetchResult.config_fingerprint != fingerprint,
                )
                .all()
            )
            for s in stale:
                db.delete(s)
            if stale:
                if not _commit_with_retry(db, f"clear-stale-fingerprint-batch{batch.id}"):
                    return  # 本周期放弃,避免带着过期会话继续

            # 重试到期且未超限的 failed 任务 → queued
            now = datetime.utcnow()
            retry_candidates = (
                db.query(MaterialPrefetchResult)
                .filter(
                    MaterialPrefetchResult.batch_id == batch.id,
                    MaterialPrefetchResult.status == PREFETCH_STATUS_FAILED,
                    MaterialPrefetchResult.attempt_count < settings.material_prefetch_max_retries,
                    MaterialPrefetchResult.next_retry_at.isnot(None),
                    MaterialPrefetchResult.next_retry_at <= now,
                )
                .all()
            )
            for rc in retry_candidates:
                rc.status = PREFETCH_STATUS_QUEUED
                rc.error_message = ""
            if retry_candidates:
                if not _commit_with_retry(db, f"reset-failed-retry-batch{batch.id}"):
                    return

            # 统计当前活跃任务数(queued + running + ready)
            active_count = (
                db.query(MaterialPrefetchResult)
                .filter(
                    MaterialPrefetchResult.batch_id == batch.id,
                    MaterialPrefetchResult.status.in_([
                        PREFETCH_STATUS_QUEUED,
                        PREFETCH_STATUS_RUNNING,
                        PREFETCH_STATUS_READY,
                    ]),
                    MaterialPrefetchResult.config_fingerprint == fingerprint,
                )
                .count()
            )

            ready_count = (
                db.query(MaterialPrefetchResult)
                .filter(
                    MaterialPrefetchResult.batch_id == batch.id,
                    MaterialPrefetchResult.status == PREFETCH_STATUS_READY,
                    MaterialPrefetchResult.config_fingerprint == fingerprint,
                )
                .count()
            )

            target = settings.material_prefetch_size
            if owner.role == ROLE_ADMIN or owner.workflow_quota is None:
                remaining = target
            else:
                remaining = max(
                    0,
                    owner.workflow_quota
                    - owner.workflow_reserved
                    - owner.workflow_charged,
                )
            max_lookahead = min(
                settings.material_prefetch_max_lookahead,
                target,
                remaining,
            )

            # 如果已达高水位或最大前瞻，不再创建新任务
            if active_count >= max_lookahead or ready_count >= target:
                # 但仍然需要处理已有的 queued 任务
                pass
            else:
                # 创建新 queued 任务直到达到目标水位或前瞻上限
                already_ids_rows = (
                    db.query(MaterialPrefetchResult.item_id)
                    .filter(MaterialPrefetchResult.batch_id == batch.id)
                    .all()
                )
                already_ids = [row[0] for row in already_ids_rows]

                # 批量创建 + 单次提交:显著降低 SQLite 写事务频率
                created: list[MaterialPrefetchResult] = []
                while (
                    active_count < max_lookahead
                    and ready_count + (active_count - ready_count) < max_lookahead
                ):
                    item_q = (
                        db.query(MaterialItem)
                        .filter(
                            MaterialItem.batch_id == batch.id,
                            MaterialItem.status == MATERIAL_STATUS_PENDING,
                        )
                    )
                    if already_ids:
                        item_q = item_q.filter(~MaterialItem.id.in_(already_ids))
                    item = item_q.order_by(MaterialItem.sequence.asc()).first()

                    if item is None:
                        break

                    pf = MaterialPrefetchResult(
                        batch_id=batch.id,
                        item_id=item.id,
                        status=PREFETCH_STATUS_QUEUED,
                        config_fingerprint=fingerprint,
                        rotation_degrees=0,
                    )
                    db.add(pf)
                    created.append(pf)
                    already_ids.append(item.id)
                    active_count += 1

                    if active_count >= max_lookahead:
                        break
                if created:
                    if not _commit_with_retry(db, f"create-queued-batch{batch.id}"):
                        return

            # 收集所有 queued 任务并并行执行
            queued_items = (
                db.query(MaterialPrefetchResult)
                .filter(
                    MaterialPrefetchResult.batch_id == batch.id,
                    MaterialPrefetchResult.status == PREFETCH_STATUS_QUEUED,
                    MaterialPrefetchResult.config_fingerprint == fingerprint,
                )
                .limit(
                    min(
                        settings.material_prefetch_concurrency,
                        3 if ready_count < 3 else 2 if ready_count < target // 2 else 1,
                    )
                )
                .all()
            )
        finally:
            db.close()

        # 并行执行 queued 任务
        if queued_items:
            # 动态调整并发：ready < target 时全速，接近 high 时降速
            tasks = []
            for pf in queued_items:
                # 再次检查 running 数量，避免超过并发限制
                tasks.append(self._run_prefetch_task(pf.id, pf.item_id, fingerprint))
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)

    async def _run_prefetch_task(self, pf_id: int, item_id: int, fingerprint: str) -> None:
        """单个预加载任务：原子领取 → 调用模型 → 保存结果。

        资源调度:预加载属于后台任务,通过 resource_scheduler 获取槽位。
        用户手动识别(前台)永远优先;内存压力时后台暂停领取,前台不受影响。
        原有 Semaphore 保留作为并发上限的兜底约束。
        任务在注册表登记,前台 request_takeover 可按 pf_id 取消本任务。
        """
        current = asyncio.current_task()
        if current is not None:
            self._tasks[pf_id] = current
        try:
            async with self._semaphore:
                if self._stop_event.is_set():
                    return
                async with self._scheduler.slot(priority="background"):
                    if self._stop_event.is_set():
                        return
                    await self._prefetch_one(item_id, pf_id, fingerprint)
        finally:
            self._tasks.pop(pf_id, None)

    # ============================================================
    # 前台接管(v1.3.10)
    # ============================================================

    async def request_takeover(self, pf_id: int) -> str:
        """前台接管:取消在途后台任务并清理预载行,避免重复模型调用。

        返回:
          "ready"     - 任务恰好已完成,结果可直接消费(零重复调用)
          "cancelled" - 已取消/清理,调用方走冷路径
        """
        task = self._tasks.get(pf_id)
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass  # 任务已被本方法取消,预期行为
            except Exception:
                pass  # 任务自身的模型错误:接管后前台冷路径覆盖
        return await _takeover_cleanup_row(pf_id)

    async def _prefetch_one(
        self,
        item_id: int,
        pf_id: int,
        fingerprint: str,
    ) -> bool:
        """对单张素材调用模型识别并保存结果。"""
        telemetry = Telemetry(path="background", item_id=item_id)
        db = SessionLocal()
        try:
            # 原子领取：queued → running
            pf = db.get(MaterialPrefetchResult, pf_id)
            if pf is None or pf.status != PREFETCH_STATUS_QUEUED:
                return False

            fresh = db.get(MaterialItem, item_id)
            if fresh is None or fresh.status != MATERIAL_STATUS_PENDING:
                db.delete(pf)
                if not _commit_with_retry(db, f"drop-missing-item-{pf_id}"):
                    return False
                return False
            batch = db.get(MaterialBatch, fresh.batch_id)
            owner = db.get(User, batch.owner_id) if batch is not None else None
            if (
                batch is None
                or not batch.is_active
                or owner is None
                or not owner.is_active
                or (
                    owner.role != ROLE_ADMIN
                    and owner.workflow_quota is not None
                    and owner.workflow_reserved + owner.workflow_charged
                    >= owner.workflow_quota
                )
            ):
                db.delete(pf)
                if not _commit_with_retry(db, f"drop-inactive-item-{pf_id}"):
                    return False
                return False
            telemetry.owner_id = batch.owner_id

            pf.status = PREFETCH_STATUS_RUNNING
            pf.attempt_count = (pf.attempt_count or 0) + 1
            pf.next_retry_at = None
            if not _commit_with_retry(db, f"claim-{pf_id}"):
                return False

            stored_path = fresh.stored_path
            original_filename = fresh.original_filename
            prefetch_rotation = pf.rotation_degrees
        finally:
            db.close()

        # 调用模型（在独立 DB session 中）
        from app.services.materials_service import resolve_material_image_path
        source = resolve_material_image_path(stored_path)
        if not source.exists():
            telemetry.error = "素材图片文件不存在"
            self._mark_failed(pf_id, "素材图片文件不存在")
            return False

        try:
            db2 = SessionLocal()
            try:
                # v1.3.10 后台预载使用独立短超时,慢/卡请求不长期占用槽位
                client = recognition_service._get_model_client(
                    db2, timeout=settings.model_background_timeout_seconds
                )
                prompt = recognition_service._load_recognition_prompt(db2)
            finally:
                db2.close()

            result = await recognition_service.recognize_image_with_ocr(
                client,
                str(source),
                prompt,
                prefetch_rotation,
                telemetry=telemetry,
            )
            from app.services.image_variant_service import get_preview_path
            try:
                await asyncio.to_thread(get_preview_path, source)
            except Exception:
                logger.warning(
                    "预览图预热失败 item_id=%s",
                    item_id,
                    exc_info=True,
                )
        except asyncio.CancelledError:
            telemetry.error = "前台接管取消"
            raise
        except Exception as exc:
            telemetry.error = f"{type(exc).__name__}: {getattr(exc, 'detail', exc)}"[:200]
            self._mark_failed(pf_id, str(getattr(exc, "detail", exc)))
            return False

        # 保存成功结果
        db3 = SessionLocal()
        try:
            pf = db3.get(MaterialPrefetchResult, pf_id)
            if pf is None:
                return False

            re_check = db3.get(MaterialItem, item_id)
            if re_check is None or re_check.status != MATERIAL_STATUS_PENDING:
                db3.delete(pf)
                _commit_with_retry(db3, f"drop-stale-result-{pf_id}")
                return False
            batch = db3.get(MaterialBatch, re_check.batch_id)
            owner = db3.get(User, batch.owner_id) if batch is not None else None
            if batch is None or owner is None or not owner.is_active:
                db3.delete(pf)
                _commit_with_retry(db3, f"drop-invalid-result-{pf_id}")
                return False

            new_fp = _get_current_fingerprint()
            if new_fp != fingerprint:
                db3.delete(pf)
                _commit_with_retry(db3, f"drop-stale-fingerprint-{pf_id}")
                return False

            pf.status = PREFETCH_STATUS_READY
            pf.result_json = json.dumps(result, ensure_ascii=False)
            pf.error_message = ""
            pf.next_retry_at = None
            t_commit = time.monotonic()
            committed = _commit_with_retry(db3, f"save-ready-{pf_id}")
            telemetry.db_commit_ms = (time.monotonic() - t_commit) * 1000.0
            return committed
        finally:
            db3.close()
            telemetry.emit()

    def _mark_failed(self, pf_id: int, error_message: str) -> None:
        """标记任务为失败，设置指数退避重试时间。

        SQLite 锁冲突时按退避序列重试整个短事务(读-改-提交)。
        """
        from app.db_retry import DatabaseUnavailableError, run_write_with_retry

        def _op() -> None:
            db = SessionLocal()
            try:
                pf = db.get(MaterialPrefetchResult, pf_id)
                if pf is None:
                    return
                re_check = db.get(MaterialItem, pf.item_id)
                if re_check is None or re_check.status != MATERIAL_STATUS_PENDING:
                    db.delete(pf)
                    if not _commit_with_retry(db, f"drop-failed-missing-item-{pf_id}"):
                        return
                    return

                attempts = pf.attempt_count or 0
                if attempts >= settings.material_prefetch_max_retries:
                    # 永久失败，不重试
                    pf.status = PREFETCH_STATUS_FAILED
                    pf.error_message = error_message
                    pf.next_retry_at = None
                else:
                    # 指数退避
                    delay = settings.material_prefetch_retry_delay * (2 ** (attempts - 1))
                    pf.status = PREFETCH_STATUS_FAILED
                    pf.error_message = error_message
                    pf.next_retry_at = datetime.utcnow() + timedelta(seconds=delay)
                _commit_with_retry(db, f"mark-failed-{pf_id}")
            finally:
                db.close()

        try:
            run_write_with_retry(_op, log_label=f"prefetch-mark-failed-{pf_id}")
        except DatabaseUnavailableError:
            logger.error("预加载失败状态写入持续锁定 pf_id=%s", pf_id)
        except Exception:
            logger.exception("预加载失败状态写入异常 pf_id=%s", pf_id)

    # ============================================================
    # 清理方法
    # ============================================================

    def _clear_all(self) -> None:
        """清除所有非 running 的预加载结果。"""
        db = SessionLocal()
        try:
            db.query(MaterialPrefetchResult).filter(
                MaterialPrefetchResult.status != PREFETCH_STATUS_RUNNING,
            ).delete(synchronize_session=False)
            _commit_with_retry(db, "clear-non-running")
        finally:
            db.close()

    def clear_for_batch(self, batch_id: int) -> None:
        """清除指定批次的所有预加载结果。"""
        db = SessionLocal()
        try:
            db.query(MaterialPrefetchResult).filter(
                MaterialPrefetchResult.batch_id == batch_id,
            ).delete(synchronize_session=False)
            _commit_with_retry(db, f"clear-batch-{batch_id}")
        finally:
            db.close()

    def clear_for_item(self, item_id: int) -> None:
        """清除指定素材的预加载结果。"""
        db = SessionLocal()
        try:
            db.query(MaterialPrefetchResult).filter(
                MaterialPrefetchResult.item_id == item_id,
            ).delete(synchronize_session=False)
            _commit_with_retry(db, f"clear-item-{item_id}")
        finally:
            db.close()

    def clear_all(self) -> None:
        """清除所有预加载结果(不区分批次)。"""
        db = SessionLocal()
        try:
            db.query(MaterialPrefetchResult).delete(synchronize_session=False)
            _commit_with_retry(db, "clear-all")
        finally:
            db.close()

    def invalidate_all(self) -> None:
        """配置变化后使所有结果失效(删除以便重新预加载)。"""
        db = SessionLocal()
        try:
            db.query(MaterialPrefetchResult).filter(
                MaterialPrefetchResult.status != PREFETCH_STATUS_RUNNING,
            ).delete(synchronize_session=False)
            _commit_with_retry(db, "invalidate-all")
        finally:
            db.close()


def get_worker() -> PrefetchWorker | None:
    """获取全局 worker 实例。"""
    return _global_worker


async def _takeover_cleanup_row(pf_id: int) -> str:
    """接管后的行清理:ready 保留供消费,其余删除(claim 守卫兜底防重)。"""
    db = SessionLocal()
    try:
        pf = db.get(MaterialPrefetchResult, pf_id)
        if pf is not None and pf.status == PREFETCH_STATUS_READY and pf.result_json:
            return "ready"
        if pf is not None:
            db.delete(pf)
            _commit_with_retry(db, f"takeover-delete-{pf_id}")
        return "cancelled"
    finally:
        db.close()


async def request_takeover(pf_id: int) -> str:
    """前台接管预载任务:取消在途后台调用并清理预载行。

    返回 "ready"(任务恰好完成,直接消费)或 "cancelled"(走冷路径)。
    worker 未运行时仅做行清理,行为安全。
    """
    worker = _global_worker
    if worker is not None:
        return await worker.request_takeover(pf_id)
    return await _takeover_cleanup_row(pf_id)


def notify_worker() -> None:
    """通知全局 worker 立即检查窗口。"""
    w = _global_worker
    if w is not None:
        w.notify()
