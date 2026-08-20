"""会话 last_seen_at 写入节流测试。"""
import pytest

from app.auth import _last_seen_cache, _should_update_last_seen, forget_last_seen
from app.config import settings
from datetime import datetime


def _reset_cache():
    _last_seen_cache.clear()


def test_first_request_writes(monkeypatch):
    _reset_cache()
    monkeypatch.setattr(settings, "auth_session_last_seen_interval_seconds", 60)
    assert _should_update_last_seen(101, datetime(2026, 8, 20, 12, 0, 0)) is True


def test_throttled_within_interval(monkeypatch):
    _reset_cache()
    monkeypatch.setattr(settings, "auth_session_last_seen_interval_seconds", 60)
    first = datetime(2026, 8, 20, 12, 0, 0)
    _should_update_last_seen(102, first)
    # 30 秒内的请求不写库
    assert _should_update_last_seen(102, first.replace(second=30)) is False


def test_writes_again_after_interval(monkeypatch):
    _reset_cache()
    monkeypatch.setattr(settings, "auth_session_last_seen_interval_seconds", 60)
    first = datetime(2026, 8, 20, 12, 0, 0)
    _should_update_last_seen(103, first)
    assert _should_update_last_seen(103, first.replace(minute=1, second=1)) is True


def test_independent_sessions(monkeypatch):
    _reset_cache()
    monkeypatch.setattr(settings, "auth_session_last_seen_interval_seconds", 60)
    now = datetime(2026, 8, 20, 12, 0, 0)
    _should_update_last_seen(201, now)
    # 另一个会话不受第一个会话的节流影响
    assert _should_update_last_seen(202, now) is True


def test_zero_interval_disables_throttle(monkeypatch):
    _reset_cache()
    monkeypatch.setattr(settings, "auth_session_last_seen_interval_seconds", 0)
    now = datetime(2026, 8, 20, 12, 0, 0)
    assert _should_update_last_seen(301, now) is True
    assert _should_update_last_seen(301, now) is True


def test_forget_clears_cache(monkeypatch):
    _reset_cache()
    monkeypatch.setattr(settings, "auth_session_last_seen_interval_seconds", 60)
    now = datetime(2026, 8, 20, 12, 0, 0)
    _should_update_last_seen(401, now)
    forget_last_seen(401)
    # 登出后再登录的同一会话 ID 不受旧节流影响
    assert _should_update_last_seen(401, now) is True
