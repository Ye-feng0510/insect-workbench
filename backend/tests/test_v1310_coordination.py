"""v1.3.10 单元测试:共享连接池、埋点、接管取消、读重试。"""
import asyncio
import logging

import pytest


def test_http_client_singleton_and_reset():
    from app.services import model_http

    model_http.reset_http_client_for_tests()
    try:
        c1 = model_http.get_http_client()
        c2 = model_http.get_http_client()
        assert c1 is c2, "连接池应为进程级单例"
        model_http.reset_http_client_for_tests()
        c3 = model_http.get_http_client()
        assert c3 is not c1, "reset 后应重建"
    finally:
        model_http.reset_http_client_for_tests()


def test_telemetry_emit_outputs_structured_line(caplog):
    from app.services.recognition_telemetry import Telemetry

    t = Telemetry(path="background", item_id=7, owner_id=1)
    t.ocr_ms = None  # OCR 关闭/跳过
    t.model_attempts = 2
    t.model_http_ms = 8231.4
    t.reasoning_escalations = 1
    with caplog.at_level(logging.INFO):
        t.emit()
    records = [r for r in caplog.records if "REC_TELEMETRY" in r.message]
    assert records, "必须输出结构化埋点日志"
    line = records[0].getMessage()
    assert "path=background" in line
    assert "item_id=7" in line
    assert "ocr_ms=skipped" in line
    assert "model_attempts=2" in line
    assert "reasoning_escalations=1" in line


def test_worker_takeover_cancels_registered_task(monkeypatch):
    """接管必须真正取消在途后台任务(零重复调用的前提)。"""
    from app.services import prefetch_service as ps

    async def fake_cleanup(pf_id):
        return "cancelled"

    monkeypatch.setattr(ps, "_takeover_cleanup_row", fake_cleanup)

    async def scenario():
        worker = ps.PrefetchWorker()  # 不 start,仅用注册表
        started = asyncio.Event()

        async def sleeper():
            started.set()
            await asyncio.sleep(30)

        task = asyncio.create_task(sleeper())
        await started.wait()
        worker._tasks[99] = task

        result = await worker.request_takeover(99)
        assert result == "cancelled"
        assert task.cancelled(), "注册表中的在途任务必须被取消"
        # 生产路径中注册表由 _run_prefetch_task 的 finally 清理,此处手动注册不经过包装器

    asyncio.run(scenario())


def test_run_read_with_retry_retries_locked_then_succeeds(monkeypatch):
    """读重试:锁冲突按退避序列重试,最终成功返回结果。"""
    from app.db_retry import run_read_with_retry
    from sqlalchemy.exc import OperationalError

    state = {"calls": 0}

    class FakeOrig(Exception):
        pass

    def operation():
        state["calls"] += 1
        if state["calls"] < 3:
            raise OperationalError("stmt", {}, FakeOrig("database is locked"))
        return "ok"

    monkeypatch.setattr("app.config.settings.sqlite_lock_retry_delays_ms", (1, 1, 1))
    assert run_read_with_retry(operation, log_label="t") == "ok"
    assert state["calls"] == 3
