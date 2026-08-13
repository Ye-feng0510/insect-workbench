"""生成并缓存用于浏览器预览的图片衍生文件。"""
from __future__ import annotations

import hashlib
import os
import threading
import time
import uuid
from pathlib import Path

from PIL import Image, ImageOps

from app.config import DATA_DIR

PREVIEW_CACHE_DIR = DATA_DIR / "image_cache" / "preview"
PREVIEW_MAX_EDGE = 1800
PREVIEW_QUALITY = 84
PREVIEW_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024
PREVIEW_CACHE_TRIM_INTERVAL_SECONDS = 3600
_locks_guard = threading.Lock()
_target_locks: dict[Path, threading.Lock] = {}
_last_trim = 0.0


def _cache_path(source: Path) -> Path:
    stat = source.stat()
    identity = f"{source.resolve()}|{stat.st_size}|{stat.st_mtime_ns}|preview-v1"
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()
    return PREVIEW_CACHE_DIR / f"{digest}.webp"


def _target_lock(target: Path) -> threading.Lock:
    with _locks_guard:
        return _target_locks.setdefault(target, threading.Lock())


def _trim_cache() -> None:
    global _last_trim
    now = time.monotonic()
    with _locks_guard:
        if now - _last_trim < PREVIEW_CACHE_TRIM_INTERVAL_SECONDS:
            return
        _last_trim = now
    entries = [path for path in PREVIEW_CACHE_DIR.glob("*.webp") if path.is_file()]
    total = sum(path.stat().st_size for path in entries)
    if total <= PREVIEW_CACHE_MAX_BYTES:
        return
    for path in sorted(entries, key=lambda item: item.stat().st_mtime_ns):
        size = path.stat().st_size
        path.unlink(missing_ok=True)
        total -= size
        if total <= PREVIEW_CACHE_MAX_BYTES * 9 // 10:
            break


def get_preview_path(source: Path) -> Path:
    """返回预览图路径，缓存无效时安全地重新生成。"""
    source = source.resolve()
    if not source.is_file():
        raise FileNotFoundError(source)
    target = _cache_path(source)
    if target.is_file() and target.stat().st_size > 0:
        return target

    lock = _target_lock(target)
    with lock:
        if target.is_file() and target.stat().st_size > 0:
            return target
        PREVIEW_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(
            f".{os.getpid()}.{threading.get_ident()}.{uuid.uuid4().hex}.tmp"
        )
        try:
            with Image.open(source) as image:
                image = ImageOps.exif_transpose(image)
                image.thumbnail((PREVIEW_MAX_EDGE, PREVIEW_MAX_EDGE), Image.Resampling.LANCZOS)
                if image.mode not in ("RGB", "RGBA"):
                    image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
                image.save(
                    temporary,
                    format="WEBP",
                    quality=PREVIEW_QUALITY,
                    method=4,
                )
            temporary.replace(target)
            _trim_cache()
        finally:
            temporary.unlink(missing_ok=True)
            with _locks_guard:
                _target_locks.pop(target, None)
    return target
