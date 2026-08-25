"""SQLite 锁冲突的有限退避重试辅助。

设计原则(与 v1.3.5 稳定性方案一致):
- 只重试短事务的提交/执行,绝不包裹完整业务流程,避免重复扣配额或重复调用模型。
- 退避序列可配置(默认 50ms/150ms/400ms)。
- 最终仍失败时抛出 DatabaseUnavailableError,由全局异常处理器转为 503。
"""
from __future__ import annotations

import asyncio
import time
from collections.abc import Callable, Iterable
from typing import TypeVar

from sqlalchemy.exc import OperationalError

from app.config import settings

T = TypeVar("T")

_LOCK_MARKERS = ("database is locked", "database table is locked", "database schema is locked")


class DatabaseUnavailableError(RuntimeError):
    """数据库暂时不可用(锁等待超时),应映射为 HTTP 503。"""


def is_locked_error(exc: BaseException) -> bool:
    """判断异常是否为 SQLite 锁冲突。"""
    if not isinstance(exc, OperationalError):
        return False
    message = str(getattr(exc, "orig", exc) or exc).lower()
    return any(marker in message for marker in _LOCK_MARKERS)


def _delays() -> Iterable[float]:
    for ms in settings.sqlite_lock_retry_delays_ms:
        yield ms / 1000.0


def run_write_with_retry(operation: Callable[[], T], log_label: str = "db-write") -> T:
    """同步短事务写入:锁冲突时按退避序列重试。

    operation 必须是幂等或可安全重放的短事务(例如:打开会话→修改→提交→关闭)。
    """
    attempt = 0
    for delay in _delays():
        try:
            return operation()
        except OperationalError as exc:
            if not is_locked_error(exc):
                raise
            attempt += 1
            time.sleep(delay)
    try:
        return operation()
    except OperationalError as exc:
        if is_locked_error(exc):
            raise DatabaseUnavailableError(
                f"{log_label}: 数据库持续锁定,短暂不可用"
            ) from exc
        raise


def run_read_with_retry(operation: Callable[[], T], log_label: str = "db-read") -> T:
    """读取查询:SQLite 锁冲突时按退避序列重试。

    与写入版语义一致;operation 内部应在捕获锁冲突前自行回滚会话。
    最终仍失败时抛出 DatabaseUnavailableError(全局映射为 503)。
    """
    return run_write_with_retry(operation, log_label=log_label)


async def run_write_with_retry_async(
    operation: Callable[[], T],
    log_label: str = "db-write",
) -> T:
    """异步版短事务写入重试,退避期间不阻塞事件循环。"""
    for delay in _delays():
        try:
            return operation()
        except OperationalError as exc:
            if not is_locked_error(exc):
                raise
            await asyncio.sleep(delay)
    try:
        return operation()
    except OperationalError as exc:
        if is_locked_error(exc):
            raise DatabaseUnavailableError(
                f"{log_label}: 数据库持续锁定,短暂不可用"
            ) from exc
        raise
