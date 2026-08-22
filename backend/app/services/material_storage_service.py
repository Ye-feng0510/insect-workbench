"""素材存储生命周期服务:磁盘预算、临时文件与旧批次安全清理。

v1.3.5 存储治理目标(低耦合,不改业务 API):
- 上传前磁盘空间预算检查(预计上传后低于安全阈值则拒绝)。
- 残留 incoming_*.zip(上传中断遗留)按时间清理。
- 新批次替换成功后,安全清理旧的非活跃批次:
  * 无任何素材项被记录引用 → 删除批次行与全部文件(复用 delete_batch 语义)。
  * 存在被引用素材项 → 保留批次与解压图片(记录可能仍依赖),仅按保留策略删除 ZIP。
- 清理在数据库事务提交成功后执行,失败仅记录日志,不影响已成功的上传。
"""
from __future__ import annotations

import logging
import shutil
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from app.config import (
    MATERIAL_IMAGES_DIR,
    MATERIAL_ZIPS_DIR,
    settings,
)
from app.models import (
    MaterialBatch,
    MaterialItem,
    MaterialPrefetchResult,
)

logger = logging.getLogger(__name__)


class StorageBudgetError(RuntimeError):
    """磁盘空间不足以完成上传。"""


def projected_free_bytes(incoming_zip_bytes: int) -> int:
    """按待上传 ZIP 字节数估算完成后的剩余空间(含解压膨胀系数)。"""
    expansion = settings.material_storage_extract_expansion_factor
    usage = shutil.disk_usage(MATERIAL_ZIPS_DIR)
    return usage.free - incoming_zip_bytes - int(incoming_zip_bytes * expansion)


def check_upload_budget(incoming_zip_bytes: int) -> dict[str, Any]:
    """上传前/落盘中磁盘预算检查。

    预算 = 临时 ZIP + 解压展开估算(ZIP 大小 × 可配膨胀系数) + 安全余量。
    调用方应传入**实际待写入字节数**(如 Content-Length 或已落盘字节数),
    而非配置上限:按上限预扣会把所有上传整体锁死(2026-08-22 生产事故)。
    预计完成后低于 material_storage_min_free_gb 时抛出 StorageBudgetError。
    """
    min_free_bytes = settings.material_storage_min_free_gb * 1024**3
    warn_free_bytes = settings.material_storage_warn_free_gb * 1024**3
    projected_free = projected_free_bytes(incoming_zip_bytes)
    info = {
        "free_bytes": shutil.disk_usage(MATERIAL_ZIPS_DIR).free,
        "projected_free_bytes": projected_free,
        "min_free_bytes": int(min_free_bytes),
        "warn": projected_free < warn_free_bytes,
    }
    if projected_free < min_free_bytes:
        raise StorageBudgetError(
            f"磁盘剩余空间不足:预计上传后仅剩 {projected_free / 1024**3:.1f}GB,"
            f"低于安全阈值 {settings.material_storage_min_free_gb:.0f}GB,"
            "请先清理旧素材批次或扩容磁盘"
        )
    return info


def cleanup_stale_incoming_zips(
    max_age_hours: int | None = None,
    *,
    now: datetime | None = None,
) -> int:
    """清理超时的 incoming_*.zip 上传临时文件,返回删除数量。"""
    if max_age_hours is None:
        max_age_hours = settings.material_storage_cleanup_incoming_max_age_hours
    if max_age_hours <= 0:
        return 0
    cutoff = (now or datetime.utcnow()) - timedelta(hours=max_age_hours)
    removed = 0
    if not MATERIAL_ZIPS_DIR.exists():
        return 0
    for path in MATERIAL_ZIPS_DIR.glob("incoming_*.zip"):
        try:
            mtime = datetime.fromtimestamp(path.stat().st_mtime)
            if mtime < cutoff:
                path.unlink(missing_ok=True)
                removed += 1
        except OSError:
            logger.warning("清理临时上传文件失败: %s", path, exc_info=True)
    if removed:
        logger.info("已清理 %d 个超时上传临时文件", removed)
    return removed


def _batch_has_referenced_items(db: Session, batch_id: int) -> bool:
    """批次中是否存在被识别记录引用的素材项。"""
    return (
        db.query(MaterialItem.id)
        .filter(
            MaterialItem.batch_id == batch_id,
            MaterialItem.record_id.isnot(None),
        )
        .limit(1)
        .count()
        > 0
    )


def _remove_batch_files(batch: MaterialBatch) -> None:
    """删除批次解压目录与 ZIP,文件多时分批限速避免 I/O 风暴抢前台。

    chunk_files<=0 时退回一次性 rmtree(旧行为)。
    """
    if batch.extract_dir:
        chunk = settings.material_storage_delete_chunk_files
        if chunk <= 0:
            shutil.rmtree(batch.extract_dir, ignore_errors=True)
        else:
            _rmtree_in_chunks(Path(batch.extract_dir), chunk)
    if batch.stored_zip_path:
        Path(batch.stored_zip_path).unlink(missing_ok=True)


def _rmtree_in_chunks(root: Path, chunk_files: int) -> None:
    """分批删除目录树:每删 chunk_files 个文件暂停片刻,让出 I/O 与 CPU。"""
    pause = settings.material_storage_delete_chunk_pause_seconds
    pending: list[Path] = [root]
    deleted_since_pause = 0
    while pending:
        current = pending.pop()
        try:
            if current.is_dir():
                pending.extend(current.iterdir())
            else:
                current.unlink(missing_ok=True)
                deleted_since_pause += 1
                if deleted_since_pause >= chunk_files:
                    deleted_since_pause = 0
                    if pause > 0:
                        time.sleep(pause)
        except OSError:
            continue  # 单文件失败不中断整体清理;残留目录由 rmtree 兜底
    shutil.rmtree(root, ignore_errors=True)


def cleanup_inactive_batches(
    db: Session,
    owner_id: int | None = None,
    *,
    retain_days: int | None = None,
) -> dict[str, Any]:
    """清理非活跃批次:未引用批次整批删除,被引用批次仅按策略删 ZIP。

    返回统计 {removed_batches, kept_referenced, removed_zips}。
    只处理创建时间早于 retain_days 的批次(0=立即)。
    """
    if retain_days is None:
        retain_days = settings.material_archive_retention_days
    cutoff = datetime.utcnow() - timedelta(days=max(0, retain_days))

    query = db.query(MaterialBatch).filter(MaterialBatch.is_active.is_(False))
    if owner_id is not None:
        query = query.filter(MaterialBatch.owner_id == owner_id)
    batches = query.order_by(MaterialBatch.id.asc()).all()

    removed_batches = 0
    kept_referenced = 0
    removed_zips = 0

    for batch in batches:
        if batch.created_at is not None and batch.created_at > cutoff:
            continue  # 保留期内,暂不处理
        try:
            if _batch_has_referenced_items(db, batch.id):
                # 被引用:保留批次与解压图片;按保留策略删除 ZIP(记录不依赖 ZIP)
                if retain_days <= 0 and batch.stored_zip_path:
                    Path(batch.stored_zip_path).unlink(missing_ok=True)
                    batch.stored_zip_path = ""  # type: ignore[assignment]
                    removed_zips += 1
                kept_referenced += 1
                continue
            # 未引用:删除预加载缓存、素材项、批次行与文件
            db.query(MaterialPrefetchResult).filter(
                MaterialPrefetchResult.batch_id == batch.id,
            ).delete(synchronize_session=False)
            db.query(MaterialItem).filter(
                MaterialItem.batch_id == batch.id,
            ).delete(synchronize_session=False)
            db.delete(batch)
            db.commit()
            _remove_batch_files(batch)
            removed_batches += 1
        except Exception:
            db.rollback()
            logger.warning(
                "清理非活跃批次失败 batch_id=%s", batch.id, exc_info=True
            )

    result = {
        "removed_batches": removed_batches,
        "kept_referenced": kept_referenced,
        "removed_zips": removed_zips,
    }
    if removed_batches or removed_zips:
        logger.info("旧批次清理完成: %s", result)
    return result


def schedule_startup_maintenance() -> None:
    """启动时轻量维护:清理超时上传临时文件(旧批次清理由上传替换触发)。"""
    try:
        cleanup_stale_incoming_zips()
        # 清理 images 目录下的孤儿 img_* 不在本次范围:记录图片由业务管理
    except Exception:
        logger.warning("启动存储维护失败", exc_info=True)


def _safe_within_materials_dir(path: Path) -> bool:
    """校验路径位于素材目录内,防止误删数据目录之外的文件。"""
    try:
        path.resolve().relative_to(MATERIAL_IMAGES_DIR.resolve())
        return True
    except ValueError:
        return False


def enforce_extract_dir_guard(extract_dir: str | Path) -> bool:
    """对外暴露的防御校验:解压目录必须位于 MATERIAL_IMAGES_DIR 内。"""
    return _safe_within_materials_dir(Path(extract_dir))


# 时间工具暴露给测试
_monotonic = time.monotonic
