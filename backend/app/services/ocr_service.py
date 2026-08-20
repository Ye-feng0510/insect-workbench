"""本地 OCR 服务。"""
from __future__ import annotations

import os
import threading
from collections.abc import Sequence
from typing import Any

from PIL import Image, ImageOps

# ONNX Runtime 默认按宿主机全部逻辑核开线程,在低配/混部服务器上
# 单次 OCR 即可抢占全部 CPU。限制为 1 线程:推理稍慢但 Web 请求保持响应。
# 可通过环境变量 OCR_CPU_THREADS 覆盖(0 表示不限制)。
OCR_CPU_THREADS = 1

_engine: Any | None = None
_engine_error: str | None = None
_engine_lock = threading.Lock()
_run_lock = threading.Lock()

# OCR 输入降采样上限:OCR 不需要原图分辨率,超限先缩小再转数组,
# 显著降低并发场景下的内存峰值(0=不限制)。
OCR_MAX_INPUT_PIXELS = 4_000_000


def _create_engine() -> Any:
    from rapidocr import RapidOCR

    kwargs: dict[str, Any] = {}
    threads = OCR_CPU_THREADS
    if threads > 0:
        # RapidOCR v3+ 支持 cpu_threads;旧版本通过 ONNX 会话选项限制
        kwargs["cpu_threads"] = threads
        os.environ.setdefault("OMP_NUM_THREADS", str(threads))
    try:
        return RapidOCR(**kwargs)
    except TypeError:
        # RapidOCR 版本不支持 cpu_threads 参数:回退到环境变量方式
        if threads > 0:
            os.environ["OMP_NUM_THREADS"] = str(threads)
        return RapidOCR()


def _get_engine() -> Any:
    global _engine, _engine_error

    if _engine is not None:
        return _engine
    if _engine_error is not None:
        raise RuntimeError(_engine_error)

    with _engine_lock:
        if _engine is not None:
            return _engine
        if _engine_error is not None:
            raise RuntimeError(_engine_error)
        try:
            _engine = _create_engine()
        except Exception as exc:
            _engine_error = f"{type(exc).__name__}: OCR engine initialization failed"
            raise RuntimeError(_engine_error) from exc
    return _engine


def _as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if hasattr(value, "tolist"):
        value = value.tolist()
    if isinstance(value, (str, bytes)):
        return [value]
    if isinstance(value, Sequence):
        return list(value)
    try:
        return list(value)
    except TypeError:
        return [value]


def _normalize_box(value: Any) -> list[Any]:
    box = _as_list(value)
    normalized: list[Any] = []
    for point in box:
        coordinates = _as_list(point)
        if len(coordinates) >= 2:
            normalized.append([
                _normalize_number(coordinates[0]),
                _normalize_number(coordinates[1]),
            ])
    return normalized


def _normalize_number(value: Any) -> int | float:
    number = float(value)
    return int(number) if number.is_integer() else number


def _line(text: Any, confidence: Any, box: Any) -> dict[str, Any] | None:
    normalized_text = str(text).strip() if text is not None else ""
    if not normalized_text:
        return None
    try:
        normalized_confidence = float(confidence)
    except (TypeError, ValueError):
        normalized_confidence = 0.0
    try:
        normalized_box = _normalize_box(box)
    except (TypeError, ValueError):
        normalized_box = []
    return {
        "text": normalized_text,
        "confidence": normalized_confidence,
        "box": normalized_box,
    }


def _parallel_output(
    boxes: Any,
    texts: Any,
    scores: Any,
) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for box, text, score in zip(
        _as_list(boxes),
        _as_list(texts),
        _as_list(scores),
    ):
        item = _line(text, score, box)
        if item is not None:
            normalized.append(item)
    return normalized


def _normalize_output(output: Any) -> list[dict[str, Any]]:
    if output is None:
        return []

    if isinstance(output, tuple) and len(output) == 2:
        candidate = output[0]
        if candidate is None or isinstance(candidate, (list, tuple)):
            output = candidate

    if isinstance(output, dict):
        boxes = output.get("boxes")
        texts = output.get("txts", output.get("texts"))
        scores = output.get("scores")
        if boxes is not None and texts is not None and scores is not None:
            return _parallel_output(boxes, texts, scores)

    boxes = getattr(output, "boxes", None)
    texts = getattr(output, "txts", getattr(output, "texts", None))
    scores = getattr(output, "scores", None)
    if boxes is not None and texts is not None and scores is not None:
        return _parallel_output(boxes, texts, scores)

    normalized: list[dict[str, Any]] = []
    for item in _as_list(output):
        if isinstance(item, dict):
            line = _line(
                item.get("text", item.get("txt")),
                item.get("confidence", item.get("score")),
                item.get("box", item.get("points")),
            )
        else:
            values = _as_list(item)
            line = _line(values[1], values[2], values[0]) if len(values) >= 3 else None
        if line is not None:
            normalized.append(line)
    return normalized


def _run_engine(engine: Any, image: Any) -> Any:
    if callable(engine):
        return engine(image)
    run = getattr(engine, "run", None)
    if callable(run):
        return run(image)
    raise TypeError("OCR engine is not callable")


def recognize_text(
    image_path: str,
    rotation_degrees: int = 0,
) -> dict[str, Any]:
    """识别图片文字，失败时返回警告而不抛出异常。"""
    try:
        import numpy as np

        engine = _get_engine()
        with Image.open(image_path) as source:
            image = ImageOps.exif_transpose(source)
            rotation = rotation_degrees % 360
            if rotation:
                image = image.rotate(-rotation, expand=True)
            # 内存峰值控制:OCR 输入降采样(OCR 不依赖原始分辨率)
            if (
                OCR_MAX_INPUT_PIXELS > 0
                and image.width * image.height > OCR_MAX_INPUT_PIXELS
            ):
                ratio = (OCR_MAX_INPUT_PIXELS / (image.width * image.height)) ** 0.5
                image = image.resize(
                    (
                        max(1, int(image.width * ratio)),
                        max(1, int(image.height * ratio)),
                    ),
                    Image.Resampling.BILINEAR,
                )
            image_array = np.asarray(image.convert("RGB"))
            image.close()
        with _run_lock:
            output = _run_engine(engine, image_array)
        del image_array
        return {"lines": _normalize_output(output), "warnings": []}
    except Exception as exc:
        return {
            "lines": [],
            "warnings": [f"OCR unavailable ({type(exc).__name__})"],
        }
