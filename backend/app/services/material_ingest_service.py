"""异步素材 ZIP 摄取任务编排。

网络收包仍由路由完成,解压/图片校验/批次入库复用 materials_service 原语,
本模块只负责任务状态、进度、后台线程与重启恢复。

v1.3.12 锁冲突韧性:
- 所有 job 行写入接入 run_write_with_retry(每次重试用全新会话/事务,
  同时覆盖 busy_timeout 型与 WAL 快照过期立即失败型两类锁);
- 线程退出兜底:job 若仍 processing 则强写终态,杜绝"线程死亡、
  任务永久 processing"导致上传 409 锁死;
- has_active_job 惰性看门狗:陈旧 processing 任务自动回收放行上传。
"""
from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import text, update
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.database import SessionLocal
from app.db_retry import DatabaseUnavailableError, run_write_with_retry
from app.models import (
    INGEST_STAGE_EXTRACTING,
    INGEST_STAGE_STANDARDIZING,
    INGEST_STATUS_COMPLETED,
    INGEST_STATUS_FAILED,
    INGEST_STATUS_PROCESSING,
    MaterialIngestJob,
)
from app.services import material_storage_service, materials_service

logger = logging.getLogger(__name__)
_threads: set[threading.Thread] = set()
_threads_lock = threading.Lock()


def has_active_job(db: Session, owner_id: int) -> bool:
    """判断 owner 是否已有未完成摄取任务(上传前的 409 门槛)。

    v1.3.12 惰性看门狗:processing 且 updated_at 超过阈值的任务视为
    线程已死亡,自动回收为 failed 并放行上传。不新增后台线程,零成本。
    被误回收但仍在运行的任务不受影响——终态写入带 processing 幂等守卫,
    线程成功收尾时照常覆盖为 completed(真相优先)。
    """
    stale_seconds = settings.material_ingest_stale_job_seconds
    if stale_seconds > 0:
        def _reap() -> None:
            try:
                cutoff = datetime.utcnow() - timedelta(seconds=stale_seconds)
                stale_jobs = (
                    db.query(MaterialIngestJob)
                    .filter(
                        MaterialIngestJob.owner_id == owner_id,
                        MaterialIngestJob.status == INGEST_STATUS_PROCESSING,
                        MaterialIngestJob.updated_at < cutoff,
                    )
                    .all()
                )
                for job in stale_jobs:
                    job.status = INGEST_STATUS_FAILED
                    job.error_message = "任务长时间无进度,已被系统自动回收,请重新上传"
                    logger.warning(
                        "看门狗回收陈旧摄取任务 job_id=%s updated_at=%s",
                        job.id,
                        job.updated_at,
                    )
                if stale_jobs:
                    db.commit()
            except OperationalError:
                db.rollback()
                raise

        try:
            run_write_with_retry(_reap, f"ingest-reap-{owner_id}")
        except Exception:
            db.rollback()
            logger.warning(
                "看门狗回收提交失败,按实时状态判断 owner_id=%s", owner_id, exc_info=True
            )
    return (
        db.query(MaterialIngestJob.id)
        .filter(
            MaterialIngestJob.owner_id == owner_id,
            MaterialIngestJob.status == INGEST_STATUS_PROCESSING,
        )
        .first()
        is not None
    )


def serialize_job(job: MaterialIngestJob) -> dict[str, Any]:
    """返回 owner 已授权的任务状态。"""
    return {
        "job_id": job.id,
        "status": job.status,
        "stage": job.stage,
        "processed_count": job.processed_count,
        "total_planned": job.total_planned,
        "total_count": job.total_count,
        "error_message": job.error_message,
        "created_at": job.created_at,
        "updated_at": job.updated_at,
    }


def _update_progress(
    job_id: int,
    processed: int,
    planned: int,
    session_factory: sessionmaker,
) -> None:
    """以可配置节流频率更新进度,避免每张图片都产生 SQLite 写事务。

    v1.3.12:接入锁冲突退避重试。进度写本身可丢弃(下一个节流周期会以
    更新值覆盖),重试后仍失败仅告警,不影响摄取流程。
    v1.3.13:改为单语句 UPDATE(免读快照,杜绝 BUSY_SNAPSHOT 型即败)+
    每连接 500ms 短 busy_timeout——可丢写不应在竞争期把摄取线程拖进
    4×15s 的等待风暴,总预算压缩到 ~2.5s 后快速放弃。
    """
    def _write() -> None:
        db = session_factory()
        try:
            db.execute(text("PRAGMA busy_timeout=500"))
            db.execute(
                update(MaterialIngestJob)
                .where(
                    MaterialIngestJob.id == job_id,
                    MaterialIngestJob.status == INGEST_STATUS_PROCESSING,
                )
                .values(processed_count=processed, total_planned=planned)
            )
            db.commit()
        finally:
            db.close()

    try:
        run_write_with_retry(_write, f"ingest-progress-{job_id}")
    except DatabaseUnavailableError:
        logger.warning(
            "更新素材摄取进度失败 job_id=%s(锁冲突重试后仍失败,进度将被下次更新覆盖)",
            job_id,
        )
    except Exception:
        logger.warning("更新素材摄取进度失败 job_id=%s", job_id, exc_info=True)


def _finalize_job(
    job_id: int,
    status: str,
    session_factory: sessionmaker,
    *,
    total_count: int | None = None,
    processed_floor: int | None = None,
    error_message: str = "",
) -> None:
    """写入任务终态(completed/failed),新会话+锁重试。

    幂等守卫:仅当任务仍处于 processing 时更新,避免覆盖看门狗/兜底/对方
    已落地的终态。
    """
    def _write() -> None:
        db = session_factory()
        try:
            job = db.get(MaterialIngestJob, job_id)
            if job is None or job.status != INGEST_STATUS_PROCESSING:
                return
            job.status = status
            if total_count is not None:
                job.total_count = total_count
            if processed_floor is not None:
                job.processed_count = max(job.processed_count, processed_floor)
            if error_message:
                job.error_message = error_message
            db.commit()
        finally:
            db.close()

    run_write_with_retry(_write, f"ingest-finalize-{job_id}")


def _ensure_terminal_state(job_id: int, session_factory: sessionmaker) -> None:
    """线程退出兜底:job 仍 processing 说明终态未落地(如终态提交连环撞锁),
    强写 failed 终态。上抛异常无意义,尽力而为并记录。
    """
    try:
        _finalize_job(
            job_id,
            INGEST_STATUS_FAILED,
            session_factory,
            error_message="摄取线程异常退出,请重新上传",
        )
    except Exception:
        logger.error("摄取线程兜底终态写入失败 job_id=%s", job_id, exc_info=True)


def _process_job(
    job_id: int,
    source_path: Path,
    filename: str,
    owner_id: int,
    session_factory: sessionmaker,
) -> None:
    """在线程池中执行解压、校验、入库与任务状态转换。"""
    last_update = 0.0
    last_processed = -1

    def progress(processed: int, planned: int) -> None:
        nonlocal last_update, last_processed
        now = time.monotonic()
        item_interval = settings.material_ingest_progress_interval_items
        seconds_interval = settings.material_ingest_progress_interval_seconds
        if (
            processed == planned
            or processed - last_processed >= max(1, item_interval)
            or now - last_update >= max(0.0, seconds_interval)
        ):
            _update_progress(job_id, processed, planned, session_factory)
            last_update = now
            last_processed = processed

    db = session_factory()
    try:
        result = materials_service.create_batch_from_zip_path(
            db,
            source_path,
            filename,
            owner_id,
            progress_cb=progress,
        )
        # v1.3.11 标准化阶段:解压完成后统一预压缩,完成前门槛拦截识别。
        # 失败不回滚批次(降级为现状临时压缩路径),任务仍可 completed。
        standardize_note = ""
        batch = materials_service.get_active_batch(db, owner_id)
        if batch is not None:
            from app.services import material_standardize_service

            if settings.material_standardize_enabled:
                _set_job_stage(job_id, INGEST_STAGE_STANDARDIZING, session_factory)
                db.expire(batch)
                try:
                    stats = material_standardize_service.standardize_batch(
                        batch.id, session_factory, progress_cb=progress
                    )
                    standardize_note = material_standardize_service.summarize_stats(stats)
                except Exception:
                    logger.warning(
                        "素材标准化失败,降级为临时压缩路径 batch_id=%s",
                        batch.id,
                        exc_info=True,
                    )
                    material_standardize_service.mark_batch_preprocess_failed(
                        batch.id, session_factory
                    )
                    standardize_note = "标准化失败已降级:识别将使用临时压缩路径"
            else:
                # 开关关闭:直接置 completed,退回 v1.3.10 行为
                material_standardize_service.mark_batch_preprocess_completed(
                    batch.id, session_factory
                )
        _prewarm_previews(result, owner_id, session_factory)
        _finalize_job(
            job_id,
            INGEST_STATUS_COMPLETED,
            session_factory,
            total_count=int(result.get("total_count", 0)),
            processed_floor=int(result.get("total_count", 0)),
            error_message=standardize_note,
        )
        from app.services.prefetch_service import notify_worker

        notify_worker()
    except Exception as exc:
        db.rollback()
        logger.warning("素材摄取失败 job_id=%s", job_id, exc_info=True)
        _ensure_terminal_state(job_id, session_factory)
        # 兜底写入的是通用文案;能提取到业务错误时再精化一次
        detail = str(getattr(exc, "detail", exc))
        if detail:
            try:
                db2 = session_factory()
                try:
                    job = db2.get(MaterialIngestJob, job_id)
                    if job is not None and job.status == INGEST_STATUS_FAILED:
                        job.error_message = detail
                        db2.commit()
                finally:
                    db2.close()
            except Exception:
                logger.warning("素材摄取失败原因落库失败 job_id=%s", job_id, exc_info=True)
        source_path.unlink(missing_ok=True)
    finally:
        db.close()


def _set_job_stage(
    job_id: int,
    stage: str,
    session_factory: sessionmaker,
) -> None:
    """更新摄取任务阶段标记(extracting/standardizing),失败仅记录日志。"""
    def _write() -> None:
        db = session_factory()
        try:
            job = db.get(MaterialIngestJob, job_id)
            if job is not None and job.status == INGEST_STATUS_PROCESSING:
                job.stage = stage
                db.commit()
        finally:
            db.close()

    try:
        run_write_with_retry(_write, f"ingest-stage-{job_id}")
    except Exception:
        logger.warning("更新摄取阶段失败 job_id=%s", job_id, exc_info=True)


def _prewarm_previews(
    summary: dict[str, Any],
    owner_id: int,
    session_factory: sessionmaker,
) -> None:
    """解析完成后有限量、顺序预生成预览,不触碰模型识别槽位。"""
    count = settings.material_preview_prewarm_count
    if count <= 0 or not summary.get("batch"):
        return
    db = session_factory()
    try:
        items = materials_service.get_preview_window(db, owner_id, limit=count)
        for item in items:
            try:
                source = materials_service.resolve_material_image_path(item.stored_path)
                if not source.is_file():
                    continue
                from app.services.image_variant_service import get_preview_path

                get_preview_path(source)
            except Exception:
                logger.warning(
                    "素材预览预热失败 item_id=%s owner_id=%s",
                    item.id,
                    owner_id,
                    exc_info=True,
                )
            interval = settings.material_preview_prewarm_interval_seconds
            if interval > 0:
                time.sleep(interval)
    finally:
        db.close()


def start_job(
    job_id: int,
    source_path: Path,
    filename: str,
    owner_id: int,
    *,
    bind: Any = None,
) -> None:
    """创建独立后台线程,不依赖请求生命周期或 TestClient event loop。

    bind 为空时使用模块级 _session_factory(测试可注入隔离工厂,
    避免后台线程直连生产 SessionLocal 污染真实数据库)。
    """
    factory = _session_factory()
    session_factory = factory if bind is None else sessionmaker(bind=bind)
    thread = threading.Thread(
        target=_run_job_thread,
        args=(job_id, source_path, filename, owner_id, session_factory),
        name=f"material-ingest-{job_id}",
        daemon=True,
    )
    with _threads_lock:
        _threads.add(thread)
    thread.start()


_factory_override: sessionmaker | None = None


def _session_factory() -> sessionmaker:
    """会话工厂解析点:默认生产 SessionLocal,测试可整体替换。

    注入方式:monkeypatch.setattr(material_ingest_service, "_factory_override", factory)
    """
    return _factory_override if _factory_override is not None else SessionLocal


def _run_job_thread(
    job_id: int,
    source_path: Path,
    filename: str,
    owner_id: int,
    session_factory: sessionmaker,
) -> None:
    try:
        _process_job(job_id, source_path, filename, owner_id, session_factory)
    finally:
        current = threading.current_thread()
        with _threads_lock:
            _threads.discard(current)
        # v1.3.12 兜底:线程以任何方式退出时,job 不得残留 processing
        _ensure_terminal_state(job_id, session_factory)


def recover_interrupted_jobs() -> None:
    """启动时将所有未完成任务标记为失败并清理临时 ZIP。

    进程重启后内存中的后台线程已不存在,保留 processing 会永久阻塞下一次上传。
    同时将标准化未完成的活跃批次降级为 failed,避免门槛锁死工作台。
    """
    db = SessionLocal()
    try:
        jobs = (
            db.query(MaterialIngestJob)
            .filter(
                MaterialIngestJob.status == INGEST_STATUS_PROCESSING,
            )
            .all()
        )
        for job in jobs:
            job.status = INGEST_STATUS_FAILED
            job.error_message = "服务器重启中断了素材解析,请重新上传"
            Path(job.source_path).unlink(missing_ok=True)
        if jobs:
            db.commit()
        # v1.3.11:重启恢复——预处理未完成的活跃批次降级可用(走临时压缩路径)
        from app.models import (
            MaterialBatch,
            PREPROCESS_STATUS_FAILED,
            PREPROCESS_STATUS_PENDING,
            PREPROCESS_STATUS_PROCESSING,
        )

        stale = (
            db.query(MaterialBatch)
            .filter(
                MaterialBatch.is_active.is_(True),
                MaterialBatch.preprocess_status.in_(
                    [PREPROCESS_STATUS_PENDING, PREPROCESS_STATUS_PROCESSING]
                ),
            )
            .all()
        )
        for batch in stale:
            batch.preprocess_status = PREPROCESS_STATUS_FAILED
        if stale:
            db.commit()
            for batch in stale:
                logger.warning(
                    "重启降级:批次 %s 标准化未完成,识别将使用临时压缩路径",
                    batch.id,
                )
    finally:
        db.close()
