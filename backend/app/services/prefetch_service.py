"""后台预加载 worker：串行填充 ready 窗口，减少工作台等待。"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from typing import Any

from app.config import settings
from app.database import SessionLocal
from app.models import (
    MATERIAL_STATUS_PENDING,
    MaterialBatch,
    MaterialItem,
    MaterialPrefetchResult,
    PREFETCH_STATUS_FAILED,
    PREFETCH_STATUS_READY,
    PREFETCH_STATUS_RUNNING,
)
from app.services import recognition_service

logger = logging.getLogger(__name__)

# 全局 worker 单例
_global_worker: PrefetchWorker | None = None


def compute_config_fingerprint(
    base_url: str,
    model_name: str,
    recognition_prompt: str,
    rotation_degrees: int = 0,
) -> str:
    """计算配置指纹，用于检测模型/提示词变化后缓存失效。"""
    raw = f"{base_url}|{model_name}|{recognition_prompt}|{rotation_degrees}"
    return hashlib.md5(raw.encode("utf-8")).hexdigest()


def _get_current_fingerprint() -> str | None:
    """读取当前数据库中的配置指纹，未配置模型时返回 None。"""
    from app.routers.settings import _get_or_create_settings

    db = SessionLocal()
    try:
        s = _get_or_create_settings(db)
        if not s.base_url or not s.api_key or not s.model_name:
            return None
        prompt = recognition_service._load_prompt(db, "recognition_prompt", "recognition_prompt.txt")
        return compute_config_fingerprint(s.base_url, s.model_name, prompt)
    finally:
        db.close()


class PrefetchWorker:
    """后台串行预加载 worker。

    - 单 asyncio task，轮询数据库决定是否需要补充窗口
    - 串行调用模型（并发=1），避免 API 限流
    - 状态完全持久化到 material_prefetch_results 表
    - Docker 重启后自动恢复 stale running 任务
    """

    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._stop_event = asyncio.Event()

    async def start(self) -> None:
        global _global_worker
        if self._task is not None:
            return
        self._recover_stale_running()
        _global_worker = self
        self._task = asyncio.create_task(self._run_loop())

    async def stop(self) -> None:
        global _global_worker
        self._stop_event.set()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        _global_worker = None
        self._stop_event.clear()

    def notify(self) -> None:
        """通知 worker 立即检查窗口（无需等待轮询间隔）。"""
        # 简单实现：不额外发信号，依赖轮询间隔足够短
        pass

    # ============================================================
    # 启动恢复
    # ============================================================

    def _recover_stale_running(self) -> None:
        """重启后把遗留的 running 任务删除，下次轮询会重新预加载。"""
        db = SessionLocal()
        try:
            db.query(MaterialPrefetchResult).filter(
                MaterialPrefetchResult.status == PREFETCH_STATUS_RUNNING,
            ).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    # ============================================================
    # 主循环
    # ============================================================

    async def _run_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                await self._fill_window()
            except Exception:
                logger.exception("预加载 worker 异常")
            try:
                await asyncio.wait_for(
                    self._stop_event.wait(),
                    timeout=settings.material_prefetch_interval,
                )
            except asyncio.TimeoutError:
                pass  # 正常超时，继续下一轮

    async def _fill_window(self) -> None:
        """检查并填充预加载窗口至目标深度。"""
        fingerprint = _get_current_fingerprint()
        if fingerprint is None:
            # 未配置模型，清理所有缓存
            self._clear_all()
            return

        db = SessionLocal()
        try:
            batch = (
                db.query(MaterialBatch)
                .filter(MaterialBatch.is_active.is_(True))
                .order_by(MaterialBatch.id.desc())
                .first()
            )
            if batch is None:
                return

            # 统计当前窗口中有效(指纹匹配)的 ready/running 数量
            ready_or_running = (
                db.query(MaterialPrefetchResult)
                .filter(
                    MaterialPrefetchResult.batch_id == batch.id,
                    MaterialPrefetchResult.status.in_([
                        PREFETCH_STATUS_READY,
                        PREFETCH_STATUS_RUNNING,
                    ]),
                    MaterialPrefetchResult.config_fingerprint == fingerprint,
                )
                .count()
            )

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
                db.commit()

            target = settings.material_prefetch_size
            while ready_or_running < target:
                # 找下一张 pending 且还没有预加载记录的素材
                already_prefetching_ids = (
                    db.query(MaterialPrefetchResult.item_id)
                    .filter(MaterialPrefetchResult.batch_id == batch.id)
                    .all()
                )
                already_ids = [row[0] for row in already_prefetching_ids]

                item = (
                    db.query(MaterialItem)
                    .filter(
                        MaterialItem.batch_id == batch.id,
                        MaterialItem.status == MATERIAL_STATUS_PENDING,
                    )
                )
                if already_ids:
                    item = item.filter(~MaterialItem.id.in_(already_ids))
                item = item.order_by(MaterialItem.sequence.asc()).first()

                if item is None:
                    break  # 没有更多素材了

                # 创建 running 记录
                pf = MaterialPrefetchResult(
                    batch_id=batch.id,
                    item_id=item.id,
                    status=PREFETCH_STATUS_RUNNING,
                    config_fingerprint=fingerprint,
                )
                db.add(pf)
                db.commit()
                db.refresh(pf)

                ready_or_running += 1

                # 串行调用模型
                success = await self._prefetch_one(item, pf.id, fingerprint)
                if not success:
                    # 失败的也算占用了一个窗口位置(但标记为 failed)
                    pass

                # 重新检查 batch 仍然活跃
                db.expire_all()
                batch_check = db.get(MaterialBatch, batch.id)
                if batch_check is None or not batch_check.is_active:
                    break
        finally:
            db.close()

    async def _prefetch_one(
        self,
        item: MaterialItem,
        pf_id: int,
        fingerprint: str,
    ) -> bool:
        """对单张素材调用模型识别并保存结果。"""
        db = SessionLocal()
        try:
            # 再次检查素材仍为 pending
            fresh = db.get(MaterialItem, item.id)
            if fresh is None or fresh.status != MATERIAL_STATUS_PENDING:
                pf = db.get(MaterialPrefetchResult, pf_id)
                if pf is not None:
                    db.delete(pf)
                    db.commit()
                return False

            # 检查素材文件存在
            from pathlib import Path
            source = Path(fresh.stored_path)
            if not source.exists():
                pf = db.get(MaterialPrefetchResult, pf_id)
                if pf is not None:
                    pf.status = PREFETCH_STATUS_FAILED
                    pf.error_message = "素材图片文件不存在"
                    db.commit()
                return False

            # 调用模型
            try:
                client = recognition_service._get_model_client(db)
                prompt = recognition_service._load_prompt(
                    db, "recognition_prompt", "recognition_prompt.txt"
                )
                result = await client.recognize_image(fresh.stored_path, prompt, 0)
            except Exception as exc:
                pf = db.get(MaterialPrefetchResult, pf_id)
                if pf is not None:
                    # 再次检查素材仍为 pending（可能被 skip 了）
                    re_check = db.get(MaterialItem, item.id)
                    if re_check is None or re_check.status != MATERIAL_STATUS_PENDING:
                        db.delete(pf)
                        db.commit()
                        return False
                    pf.status = PREFETCH_STATUS_FAILED
                    pf.error_message = str(getattr(exc, "detail", exc))
                    db.commit()
                return False

            # 保存成功结果
            pf = db.get(MaterialPrefetchResult, pf_id)
            if pf is None:
                # 已被删除（批次删除等）
                return False

            # 再次验证素材仍为 pending 且指纹未变
            re_check = db.get(MaterialItem, item.id)
            if re_check is None or re_check.status != MATERIAL_STATUS_PENDING:
                db.delete(pf)
                db.commit()
                return False

            new_fp = _get_current_fingerprint()
            if new_fp != fingerprint:
                db.delete(pf)
                db.commit()
                return False

            pf.status = PREFETCH_STATUS_READY
            pf.result_json = json.dumps(result, ensure_ascii=False)
            pf.error_message = ""
            db.commit()
            return True
        finally:
            db.close()

    # ============================================================
    # 清理
    # ============================================================

    def _clear_all(self) -> None:
        """清除所有预加载结果。"""
        db = SessionLocal()
        try:
            db.query(MaterialPrefetchResult).filter(
                MaterialPrefetchResult.status != PREFETCH_STATUS_RUNNING,
            ).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def clear_for_batch(self, batch_id: int) -> None:
        """清除指定批次的所有预加载结果。"""
        db = SessionLocal()
        try:
            db.query(MaterialPrefetchResult).filter(
                MaterialPrefetchResult.batch_id == batch_id,
            ).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def clear_for_item(self, item_id: int) -> None:
        """清除指定素材的预加载结果。"""
        db = SessionLocal()
        try:
            db.query(MaterialPrefetchResult).filter(
                MaterialPrefetchResult.item_id == item_id,
            ).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def clear_all(self) -> None:
        """清除所有预加载结果(不区分批次)。"""
        db = SessionLocal()
        try:
            db.query(MaterialPrefetchResult).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def invalidate_all(self) -> None:
        """配置变化后使所有 ready 结果失效(删除以便重新预加载)。"""
        db = SessionLocal()
        try:
            db.query(MaterialPrefetchResult).filter(
                MaterialPrefetchResult.status == PREFETCH_STATUS_READY,
            ).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()


def get_worker() -> PrefetchWorker | None:
    """获取全局 worker 实例。"""
    return _global_worker
