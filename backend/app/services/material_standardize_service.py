"""素材图片标准化服务(v1.3.11 门槛式预压缩)。

解压落盘后、开始识别前,将批次图片统一压缩为长边受限的 JPEG 标准图:
- 原子替换(os.replace),崩溃不留半张图;ZIP 原件永久保留可回溯
- 已达标小图按节省比例跳过,零扰动
- PNG/WebP 转 JPEG 时同步改后缀并更新 material_items.stored_path
- 单线程逐张处理,每张前检查批次仍存在;内存压力时退避等待

设计约束:
- 全部阈值来自 settings(环境变量),无硬编码
- 独立模块,不依赖识别/预取/预览服务,可被任意编排器调用
"""
from __future__ import annotations

import io
import logging
import os
import time
from pathlib import Path
from typing import Any, Callable

from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.models import (
    MATERIAL_STATUS_PENDING,
    MaterialBatch,
    MaterialItem,
    PREPROCESS_STATUS_COMPLETED,
    PREPROCESS_STATUS_FAILED,
    PREPROCESS_STATUS_PROCESSING,
)
from app.services.materials_service import resolve_material_image_path

logger = logging.getLogger(__name__)

ProgressCallback = Callable[[int, int], None]

# 内存退避探测复用资源调度器的读取器(读 /proc/meminfo,不可用平台返回 None)
from app.services.resource_scheduler import ResourceScheduler


def _memory_backoff() -> None:
    """可用内存低于压力阈值时等待,避免标准化线程加剧内存压力。"""
    wait = settings.material_standardize_memory_backoff_seconds
    threshold = settings.resource_memory_pressure_mb
    if wait <= 0 or threshold <= 0:
        return
    available = ResourceScheduler.available_memory_mb()
    if available is not None and available < threshold:
        time.sleep(wait)


def _transform_image(source: Path, target: Path) -> bool:
    """读取 source,EXIF 纠正+RGB+长边压缩后写 target(JPEG)。

    返回是否写入成功(损坏图返回 False,调用方跳过该张)。
    """
    long_edge = settings.material_standardize_long_edge
    quality = settings.material_standardize_jpeg_quality
    try:
        with Image.open(source) as image:
            img = ImageOps.exif_transpose(image)
            if img.mode != "RGB":
                img = img.convert("RGB")
            if long_edge > 0 and max(img.size) > long_edge:
                ratio = long_edge / max(img.size)
                img = img.resize(
                    (max(1, int(img.width * ratio)), max(1, int(img.height * ratio))),
                    Image.Resampling.LANCZOS,
                )
            img.save(target, format="JPEG", quality=quality)
            img.close()
        return True
    except (UnidentifiedImageError, OSError, ValueError):
        return False


def _should_replace(old_size: int, new_size: int) -> bool:
    """节省比例门槛:新文件不足旧文件的 min_saving_ratio 倍才替换。"""
    if old_size <= 0:
        return True
    return new_size < old_size * settings.material_standardize_min_saving_ratio


def standardize_batch(
    batch_id: int,
    session_factory: sessionmaker,
    progress_cb: ProgressCallback | None = None,
) -> dict[str, Any]:
    """将批次内 pending 素材图统一标准化为压缩 JPEG。

    单线程逐张处理;每张原子替换或跳过;批次被删除时优雅中止。
    返回统计 {processed, replaced, skipped, failed, renamed}。
    异常由调用方(ingest 编排)决定降级策略,本函数不抛业务异常。
    """
    stats = {
        "processed": 0,
        "replaced": 0,
        "skipped": 0,
        "failed": 0,
        "renamed": 0,
    }
    db: Session = session_factory()
    try:
        batch = db.get(MaterialBatch, batch_id)
        if batch is None:
            return stats
        total = int(batch.total_count or 0)
        items = (
            db.query(MaterialItem)
            .filter(
                MaterialItem.batch_id == batch_id,
                MaterialItem.status == MATERIAL_STATUS_PENDING,
            )
            .order_by(MaterialItem.sequence.asc())
            .all()
        )
        batch.preprocess_status = PREPROCESS_STATUS_PROCESSING
        batch.preprocessed_count = 0
        db.commit()

        for index, item in enumerate(items, start=1):
            # 批次被用户删除/切换时优雅中止(状态由调用方决定)
            fresh_batch = db.get(MaterialBatch, batch_id)
            if fresh_batch is None:
                return stats
            _memory_backoff()

            source = resolve_material_image_path(item.stored_path)
            if not source.is_file():
                stats["failed"] += 1
            else:
                stats = _standardize_one(db, item, source, stats)

            # processed = 每张都计数(替换/跳过/失败均算"已处理")
            stats["processed"] = (
                stats["replaced"] + stats["skipped"] + stats["failed"]
            )
            fresh_batch.preprocessed_count = stats["processed"]
            if progress_cb is not None:
                progress_cb(index, total or len(items))
            if index % 5 == 0 or index == len(items):
                db.commit()

        final_batch = db.get(MaterialBatch, batch_id)
        if final_batch is not None:
            final_batch.preprocess_status = PREPROCESS_STATUS_COMPLETED
            final_batch.preprocessed_count = stats["processed"]
            db.commit()
        db.expire_all()
        return stats
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def _standardize_one(
    db: Session,
    item: MaterialItem,
    source: Path,
    stats: dict[str, Any],
) -> dict[str, Any]:
    """标准化单张:临时文件 → 节省判定 → 原子替换/跳过/后缀同步。"""
    old_size = source.stat().st_size
    target = source.with_name(f"{source.stem}.std_{os.getpid()}.jpg")
    if not _transform_image(source, target):
        target.unlink(missing_ok=True)
        stats["failed"] += 1
        return stats

    new_size = target.stat().st_size
    if not _should_replace(old_size, new_size):
        # 已达标小图:保持原样,清理临时文件
        target.unlink(missing_ok=True)
        stats["skipped"] += 1
        return stats

    if source.suffix.lower() != ".jpg":
        # PNG/WebP → JPEG:替换到 .jpg 路径并同步 stored_path,旧文件清理
        new_path = _jpg_path_for(source)
        os.replace(target, new_path)
        source.unlink(missing_ok=True)
        item.stored_path = str(new_path)
        db.commit()
        stats["renamed"] += 1
    else:
        os.replace(target, source)

    stats["replaced"] += 1
    return stats


def _jpg_path_for(source: Path) -> Path:
    """返回同名 .jpg 路径(PNG/WebP 转 JPEG 时更换后缀)。"""
    return source.with_name(f"{source.stem}.jpg")


def mark_batch_preprocess_failed(batch_id: int, session_factory: sessionmaker) -> None:
    """标准化失败降级:批次标记 failed(可用),识别走临时压缩路径。

    无论当前状态(pending/processing)均强制降级——调用语境即"标准化已判失败"。
    """
    db: Session = session_factory()
    try:
        batch = db.get(MaterialBatch, batch_id)
        if batch is not None:
            batch.preprocess_status = PREPROCESS_STATUS_FAILED
            db.commit()
    finally:
        db.close()


def mark_batch_preprocess_completed(
    batch_id: int,
    session_factory: sessionmaker,
) -> None:
    """跳过标准化(开关关闭等场景)时直接置完成,保持门槛语义一致。"""
    db: Session = session_factory()
    try:
        batch = db.get(MaterialBatch, batch_id)
        if batch is not None:
            batch.preprocess_status = PREPROCESS_STATUS_COMPLETED
            batch.preprocessed_count = int(batch.total_count or 0)
            db.commit()
    finally:
        db.close()


def summarize_stats(stats: dict[str, Any]) -> str:
    """统计转可读文本,供任务 error_message/日志说明降级原因。"""
    return (
        f"标准化完成: 处理{stats['processed']} 替换{stats['replaced']} "
        f"跳过{stats['skipped']} 失败{stats['failed']} 改后缀{stats['renamed']}"
    )
