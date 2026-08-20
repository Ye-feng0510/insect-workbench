"""资源调度器测试:前台优先、并发保留、内存压力让渡。"""
import asyncio

import pytest

from app.services import resource_scheduler as rs


def test_foreground_preempts_waiting_background():
    """槽位释放时,排队的后台任务必须让位给后到的前台任务。"""
    scheduler = rs.ResourceScheduler(slots=1)

    async def scenario():
        # 后台占用唯一槽位
        await scheduler.acquire(priority="background")
        order: list[str] = []

        async def background_waiter():
            await scheduler.acquire(priority="background")
            order.append("background")
            scheduler.release(priority="background")

        async def foreground_waiter():
            await scheduler.acquire(priority="foreground")
            order.append("foreground")
            scheduler.release(priority="foreground")

        bg = asyncio.create_task(background_waiter())
        await asyncio.sleep(0.01)
        fg = asyncio.create_task(foreground_waiter())
        await asyncio.sleep(0.01)
        # 释放后台槽位:前台必须先于早已排队的后台获得槽位
        scheduler.release(priority="background")
        await asyncio.gather(bg, fg)
        assert order == ["foreground", "background"]

    asyncio.run(scenario())


def test_concurrency_preserved_all_slots_usable():
    """资源充足时,全部并发槽位可同时被后台占用(保留并发能力)。"""
    scheduler = rs.ResourceScheduler(slots=3)

    async def scenario():
        async with scheduler.slot(priority="background"):
            async with scheduler.slot(priority="background"):
                async with scheduler.slot(priority="background"):
                    stats = scheduler.stats()
                    assert stats.background_active == 3
        assert scheduler.stats().background_active == 0

    asyncio.run(scenario())


def test_memory_pressure_pauses_background_not_foreground(monkeypatch):
    """内存压力时后台暂停领取,前台不受限。"""
    scheduler = rs.ResourceScheduler(slots=1)
    monkeypatch.setattr(rs.settings, "resource_memory_pressure_mb", 256)

    def fake_available():
        return 100.0  # 远低于 256MB 阈值

    monkeypatch.setattr(scheduler, "available_memory_mb", fake_available)

    async def scenario():
        # 直接设置已持续压力状态,越过 2 秒抖动判定窗口
        scheduler._pressure_since = rs.time.monotonic() - 10.0

        await scheduler.acquire(priority="foreground")
        scheduler.release(priority="foreground")

        async def try_background():
            await scheduler.acquire(priority="background")

        task = asyncio.create_task(try_background())
        await asyncio.sleep(0.05)
        assert not task.done(), "内存压力时后台不应获得槽位"
        assert scheduler.stats().memory_paused is True

        # 前台在压力下仍可立即获得槽位
        await scheduler.acquire(priority="foreground")
        scheduler.release(priority="foreground")
        task.cancel()

    asyncio.run(scenario())


def test_memory_pressure_disabled_by_config(monkeypatch):
    """RESOURCE_MEMORY_PRESSURE_MB=0 时禁用内存让渡。"""
    scheduler = rs.ResourceScheduler(slots=2)
    monkeypatch.setattr(rs.settings, "resource_memory_pressure_mb", 0)

    async def scenario():
        async with scheduler.slot(priority="background"):
            stats = scheduler.stats()
            assert stats.memory_paused is False

    asyncio.run(scenario())


def test_stats_reports_waiting_counts():
    """stats 正确报告等待中的前台/后台任务数。"""
    scheduler = rs.ResourceScheduler(slots=1)

    async def acquire_and_release(priority: str):
        await scheduler.acquire(priority)
        scheduler.release(priority=priority)

    async def scenario():
        await scheduler.acquire(priority="foreground")
        bg1 = asyncio.create_task(acquire_and_release("background"))
        bg2 = asyncio.create_task(acquire_and_release("background"))
        await asyncio.sleep(0.02)
        stats = scheduler.stats()
        assert stats.foreground_active == 1
        assert stats.background_waiting == 2
        scheduler.release(priority="foreground")
        await asyncio.gather(bg1, bg2)
        assert scheduler.stats().background_active == 0

    asyncio.run(scenario())


def test_slot_context_manager_releases_on_exception():
    """异常路径也必须释放槽位。"""
    scheduler = rs.ResourceScheduler(slots=1)

    async def scenario():
        with pytest.raises(RuntimeError):
            async with scheduler.slot(priority="foreground"):
                raise RuntimeError("boom")
        assert scheduler.stats().foreground_active == 0
        # 槽位可再次获取
        async with scheduler.slot(priority="foreground"):
            assert scheduler.stats().foreground_active == 1

    asyncio.run(scenario())
