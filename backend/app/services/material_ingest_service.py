"""异步素材 ZIP 摄取任务编排。

网络收包仍由路由完成,解压/图片校验/批次入库复用 materials_service 原语,
本模块只负责任务状态、进度、后台线程与重启恢复。
"""
from __future__ import annotations

import logging
import threading
import time
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session, sessionmaker
from app.config import settings
from app.database import SessionLocal
from app.models import (
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
    """判断 owner 是否已有未完成摄取任务。"""
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
    """以可配置节流频率更新进度,避免每张图片都产生 SQLite 写事务。"""
    db = session_factory()
    try:
        job = db.get(MaterialIngestJob, job_id)
        if job is None or job.status != INGEST_STATUS_PROCESSING:
            return
        job.processed_count = processed
        job.total_planned = planned
        db.commit()
    except Exception:
        db.rollback()
        logger.warning("更新素材摄取进度失败 job_id=%s", job_id, exc_info=True)
    finally:
        db.close()


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
        _prewarm_previews(result, owner_id, session_factory)
        job = db.get(MaterialIngestJob, job_id)
        if job is not None:
            job.status = INGEST_STATUS_COMPLETED
            job.total_count = int(result.get("total_count", 0))
            job.processed_count = max(job.processed_count, job.total_count)
            job.error_message = ""
            db.commit()
        from app.services.prefetch_service import notify_worker

        notify_worker()
    except Exception as exc:
        db.rollback()
        job = db.get(MaterialIngestJob, job_id)
        if job is not None:
            job.status = INGEST_STATUS_FAILED
            job.error_message = str(getattr(exc, "detail", exc))
            db.commit()
        logger.warning("素材摄取失败 job_id=%s", job_id, exc_info=True)
        source_path.unlink(missing_ok=True)
    finally:
        db.close()


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
    """创建独立后台线程,不依赖请求生命周期或 TestClient event loop。"""
    session_factory = SessionLocal if bind is None else sessionmaker(bind=bind)
    thread = threading.Thread(
        target=_run_job_thread,
        args=(job_id, source_path, filename, owner_id, session_factory),
        name=f"material-ingest-{job_id}",
        daemon=True,
    )
    with _threads_lock:
        _threads.add(thread)
    thread.start()


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


def recover_interrupted_jobs() -> None:
    """启动时将所有未完成任务标记为失败并清理临时 ZIP。

    进程重启后内存中的后台线程已不存在,保留 processing 会永久阻塞下一次上传。
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
    finally:
        db.close()
