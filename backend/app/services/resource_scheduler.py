"""前台优先的资源调度器:保留并发能力,用户操作永远优先。

v1.3.5 稳定性方案核心:
- 识别类任务(手动识别=前台,后台预加载=后台)共享全局槽位(默认 3,可配置)。
- 槽位释放时优先唤醒前台等待者;前台点击识别不会被排队中的预加载阻塞。
- 后台任务在系统可用内存低于阈值时暂停领取新槽位(前台不受限),内存恢复后自动继续。
- 并发没有被移除:资源充足时后台仍可并行 3 路,保证工作台切换流畅。

内存探测:Linux 读取 /proc/meminfo(MemAvailable),无 /proc 的平台(如 Windows 开发机)
视为无压力,可通过 RESOURCE_MEMORY_PRESSURE_MB=0 显式禁用。
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from pathlib import Path

from app.config import settings

logger = logging.getLogger(__name__)

PROC_MEMINFO = Path("/proc/meminfo")


@dataclass
class _Waiter:
    future: asyncio.Future
    priority: str  # "foreground" | "background"
    seq: int


@dataclass
class SchedulerStats:
    foreground_active: int = 0
    background_active: int = 0
    foreground_waiting: int = 0
    background_waiting: int = 0
    memory_paused: bool = False


class ResourceScheduler:
    """前台优先的识别槽位调度器。

    手动识别(foreground)与后台预加载(background)共享全局槽位,
    槽位释放时优先唤醒前台等待者;内存压力时仅暂停后台领取。
    """

    def __init__(self, slots: int | None = None) -> None:
        self.slots = slots if slots and slots > 0 else settings.resource_recognition_slots
        self._foreground_active = 0
        self._background_active = 0
        self._waiters: list[_Waiter] = []
        self._seq = 0
        self._pressure_since: float | None = None
        self._last_pressure_log = 0.0

    @property
    def _active(self) -> int:
        return self._foreground_active + self._background_active

    # ============================================================
    # 系统内存压力探测(仅用于后台任务让渡,前台不受限)
    # ============================================================

    @staticmethod
    def available_memory_mb() -> float | None:
        """返回系统可用内存 MB;无法探测的平台返回 None(视为无压力)。"""
        if not PROC_MEMINFO.exists():
            return None
        try:
            for line in PROC_MEMINFO.read_text(encoding="ascii").splitlines():
                if line.startswith("MemAvailable:"):
                    return float(line.split()[1]) / 1024.0
        except (OSError, ValueError, IndexError):
            return None
        return None

    def _memory_paused(self) -> bool:
        threshold = settings.resource_memory_pressure_mb
        if threshold <= 0:
            return False
        available = self.available_memory_mb()
        if available is None or available >= threshold:
            self._pressure_since = None
            return False
        now = time.monotonic()
        if self._pressure_since is None:
            self._pressure_since = now
        # 连续 2 秒低于阈值才算真正压力,避免瞬时抖动暂停后台
        return (now - self._pressure_since) >= 2.0

    def _maybe_log_pressure(self, paused: bool) -> None:
        if not paused:
            return
        now = time.monotonic()
        if now - self._last_pressure_log > 60.0:
            self._last_pressure_log = now
            logger.warning(
                "系统可用内存低于 %sMB,后台预加载暂停领取新任务(前台识别不受影响)",
                settings.resource_memory_pressure_mb,
            )

    # ============================================================
    # 槽位获取与释放
    # ============================================================

    def _can_grant(self, priority: str) -> bool:
        if self._active >= self.slots:
            return False
        if priority == "background" and self._memory_paused():
            return False
        return True

    def _wake_next(self) -> None:
        # 前台等待者绝对优先;同级按 FIFO(seq)
        pending: list[_Waiter] = [w for w in self._waiters if not w.future.done()]
        while self._active < self.slots:
            foreground = [w for w in pending if w.priority == "foreground"]
            background = [w for w in pending if w.priority == "background"]
            candidates = foreground or background
            if not candidates:
                break
            waiter = min(candidates, key=lambda w: w.seq)
            if waiter.priority == "background" and self._memory_paused():
                break
            self._waiters.remove(waiter)
            pending.remove(waiter)
            if waiter.priority == "foreground":
                self._foreground_active += 1
            else:
                self._background_active += 1
            waiter.future.set_result(None)

    async def acquire(self, priority: str = "foreground") -> None:
        """获取一个识别槽位。priority: foreground(用户手动操作) 或 background(预加载)。"""
        assert priority in ("foreground", "background")
        loop = asyncio.get_running_loop()
        if self._can_grant(priority):
            if priority == "foreground":
                self._foreground_active += 1
            else:
                self._background_active += 1
            self._maybe_log_pressure(priority == "background" and self._memory_paused())
            return
        waiter = _Waiter(future=loop.create_future(), priority=priority, seq=self._seq)
        self._seq += 1
        self._waiters.append(waiter)
        if priority == "background":
            self._maybe_log_pressure(self._memory_paused())
        try:
            await waiter.future
        except asyncio.CancelledError:
            if waiter in self._waiters:
                self._waiters.remove(waiter)
            raise

    def release(self, priority: str = "foreground") -> None:
        """释放一个槽位并立即唤醒优先级最高的等待者。"""
        if priority == "foreground":
            if self._foreground_active > 0:
                self._foreground_active -= 1
        elif self._background_active > 0:
            self._background_active -= 1
        self._wake_next()

    def stats(self) -> SchedulerStats:
        pending = [w for w in self._waiters if not w.future.done()]
        return SchedulerStats(
            foreground_active=self._foreground_active,
            background_active=self._background_active,
            foreground_waiting=sum(1 for w in pending if w.priority == "foreground"),
            background_waiting=sum(1 for w in pending if w.priority == "background"),
            memory_paused=self._memory_paused(),
        )

    # ============================================================
    # 异步上下文管理器
    # ============================================================

    def slot(self, priority: str = "foreground"):
        return _SlotContext(self, priority)


class _SlotContext:
    def __init__(self, scheduler: ResourceScheduler, priority: str) -> None:
        self._scheduler = scheduler
        self._priority = priority

    async def __aenter__(self) -> None:
        await self._scheduler.acquire(self._priority)

    async def __aexit__(self, exc_type, exc, tb) -> None:
        self._scheduler.release(self._priority)
        return None


# 全局单例:手动识别与预加载共享同一调度器
_global_scheduler: ResourceScheduler | None = None


def get_scheduler() -> ResourceScheduler:
    global _global_scheduler
    if _global_scheduler is None:
        _global_scheduler = ResourceScheduler()
    return _global_scheduler


def reset_scheduler_for_tests() -> None:
    global _global_scheduler
    _global_scheduler = None
