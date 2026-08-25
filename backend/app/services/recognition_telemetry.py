"""识别链路分段耗时埋点(纯结构化日志,无表、无对外 API 变更)。

每次识别输出一条 INFO,字段:
  path(foreground|background) / item_id / owner_id
  ocr_ms(None=OCR 关闭或跳过) / image_prepare_ms
  model_attempts / model_http_ms(累计) / reasoning_escalations / model_total_ms
  db_commit_ms / total_ms / cache_hit / error

设计约束:
- Telemetry 以可选参数注入,所有既有调用点不传即无感;
- emit 由调用方在 finally 中触发,异常路径也输出(error 字段);
- 只做观测,不影响任何业务分支。
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


@dataclass
class Telemetry:
    """一次识别的分段耗时收集器。"""

    path: str = "foreground"  # foreground | background
    item_id: int | None = None
    owner_id: int | None = None
    cache_hit: bool = False
    error: str | None = None

    ocr_ms: float | None = None        # None=OCR 未启用/跳过
    image_prepare_ms: float | None = None
    model_attempts: int = 0
    model_http_ms: float | None = None  # 多次尝试累计
    reasoning_escalations: int = 0
    model_total_ms: float | None = None
    db_commit_ms: float | None = None

    _t_start: float = field(default_factory=time.monotonic, repr=False)

    def measure(self, attr: str) -> "_Timer":
        """返回计时上下文管理器,结束时写入指定字段(毫秒)。"""
        return _Timer(self, attr)

    def emit(self) -> None:
        """输出结构化日志行(幂等,由调用方在 finally 触发一次)。"""
        logger.info(
            "REC_TELEMETRY path=%s item_id=%s owner_id=%s cache_hit=%s "
            "ocr_ms=%s image_prepare_ms=%s model_attempts=%d model_http_ms=%s "
            "reasoning_escalations=%d model_total_ms=%s db_commit_ms=%s "
            "total_ms=%d error=%s",
            self.path,
            self.item_id,
            self.owner_id,
            self.cache_hit,
            _fmt_ms(self.ocr_ms),
            _fmt_ms(self.image_prepare_ms),
            self.model_attempts,
            _fmt_ms(self.model_http_ms),
            self.reasoning_escalations,
            _fmt_ms(self.model_total_ms),
            _fmt_ms(self.db_commit_ms),
            int((time.monotonic() - self._t_start) * 1000),
            self.error if self.error is None else str(self.error)[:200],
        )


def _fmt_ms(value: float | None) -> str:
    return "skipped" if value is None else f"{value:.0f}"


class _Timer:
    """同步计时上下文,把耗时(ms)写入 telemetry 指定字段。"""

    def __init__(self, telemetry: Telemetry, attr: str):
        self._telemetry = telemetry
        self._attr = attr
        self._t0 = 0.0

    def __enter__(self) -> "_Timer":
        self._t0 = time.monotonic()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        elapsed = (time.monotonic() - self._t0) * 1000.0
        setattr(self._telemetry, self._attr, elapsed)
