"""SQLite 锁重试与 503 映射测试。"""
import asyncio

import pytest
from sqlalchemy.exc import OperationalError

from app.db_retry import (
    DatabaseUnavailableError,
    is_locked_error,
    run_write_with_retry,
    run_write_with_retry_async,
)


class _LockedError(OperationalError):
    def __init__(self, message: str = "database is locked"):
        super().__init__("stmt", {}, Exception(message))


def test_is_locked_error_matches_lock_markers():
    assert is_locked_error(_LockedError("database is locked"))
    assert is_locked_error(_LockedError("(sqlite3.OperationalError) database table is locked"))
    assert not is_locked_error(OperationalError("stmt", {}, Exception("no such table: x")))


def test_run_write_with_retry_succeeds_after_transient_locks():
    calls = {"n": 0}

    def op():
        calls["n"] += 1
        if calls["n"] < 3:
            raise _LockedError()
        return "ok"

    assert run_write_with_retry(op) == "ok"
    assert calls["n"] == 3


def test_run_write_with_retry_raises_unavailable_after_exhaustion():
    def op():
        raise _LockedError()

    with pytest.raises(DatabaseUnavailableError):
        run_write_with_retry(op, log_label="test")


def test_run_write_with_retry_does_not_retry_other_errors():
    calls = {"n": 0}

    def op():
        calls["n"] += 1
        raise OperationalError("stmt", {}, Exception("no such table: users"))

    with pytest.raises(OperationalError):
        run_write_with_retry(op)
    assert calls["n"] == 1


def test_async_retry_sleeps_without_blocking():
    calls = {"n": 0}

    def op():
        calls["n"] += 1
        if calls["n"] < 2:
            raise _LockedError()
        return 42

    async def scenario():
        return await run_write_with_retry_async(op)

    assert asyncio.run(scenario()) == 42
    assert calls["n"] == 2


def test_503_handler_registered():
    """应用异常处理器已把数据库锁定映射为 503。"""
    from app.main import app

    routes = {route.path for route in app.routes}
    assert "/api/health" in routes
    handlers = app.exception_handlers
    assert DatabaseUnavailableError in handlers
    assert OperationalError in handlers
