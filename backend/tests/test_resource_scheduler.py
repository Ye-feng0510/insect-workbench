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


def test_concurrency_preserved_all_slots_usable(monkeypatch):
    """资源充足且未配置后台上限时,全部并发槽位可同时被后台占用(保留并发能力)。"""
    monkeypatch.setattr(rs.settings, "resource_background_max_slots", 3)
    scheduler = rs.ResourceScheduler(slots=3)

    async def scenario():
        async with scheduler.slot(priority="background"):
            async with scheduler.slot(priority="background"):
                async with scheduler.slot(priority="background"):
                    stats = scheduler.stats()
                    assert stats.background_active == 3
                    assert stats.background_max == 3
        assert scheduler.stats().background_active == 0

    asyncio.run(scenario())


def test_background_slot_cap_limits_parallel_background(monkeypatch):
    """v1.3.10 后台槽位上限:后台最多占用 background_max 个槽位,其余排队。"""
    monkeypatch.setattr(rs.settings, "resource_background_max_slots", 1)
    scheduler = rs.ResourceScheduler(slots=3)

    async def scenario():
        # 第一个后台任务获得槽位
        await scheduler.acquire(priority="background")
        assert scheduler.stats().background_active == 1

        # 第二个后台任务必须等待(即使还有 2 个空槽位)
        async def bg2_acquire():
            await scheduler.acquire(priority="background")
            scheduler.release(priority="background")

        bg2 = asyncio.create_task(bg2_acquire())
        await asyncio.sleep(0.05)
        assert not bg2.done(), "后台占用达到上限时,新后台任务应等待"

        # 前台不受上限影响,立即获得槽位
        await scheduler.acquire(priority="foreground")
        scheduler.release(priority="foreground")

        scheduler.release(priority="background")
        await bg2
        assert scheduler.stats().background_active == 0

    asyncio.run(scenario())


def test_foreground_waiting_gates_new_background(monkeypatch):
    """v1.3.10 前台门禁:有前台在等时,空闲槽位也不发给新后台任务。"""
    monkeypatch.setattr(rs.settings, "resource_background_max_slots", 3)
    scheduler = rs.ResourceScheduler(slots=1)

    async def scenario():
        # 唯一槽位被后台占用
        await scheduler.acquire(priority="background")
        # 前台排队
        async def fg_acquire():
            await scheduler.acquire(priority="foreground")
            scheduler.release(priority="foreground")

        fg = asyncio.create_task(fg_acquire())
        await asyncio.sleep(0.02)
        assert scheduler.stats().foreground_waiting == 1
        # 空闲判定:槽位仍被后台占用,但等待者存在即验证唤醒顺序
        # 释放后台槽位:必须先唤醒前台,而不是让新后台拿走
        scheduler.release(priority="background")
        await fg
        assert scheduler.stats().foreground_active == 0

        # 前台等待消失后,后台可再次获得槽位
        async with scheduler.slot(priority="background"):
            assert scheduler.stats().background_active == 1

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


def test_auto_background_max_follows_prefetch_concurrency(monkeypatch):
    """v1.3.13 自动模式(=0):后台并发跟随预取并发,但保留前台余量。

    旧默认 1 会架空 MATERIAL_PREFETCH_CONCURRENCY:信号量放行 4 路,
    调度器却只给 1 个后台槽位,预取产能被锁死。
    """
    monkeypatch.setattr(rs.settings, "resource_background_max_slots", 0)
    monkeypatch.setattr(rs.settings, "material_prefetch_concurrency", 4)

    # 3 槽位:自动 = min(4, 3-1) = 2,前台永远有 1 个空位
    scheduler = rs.ResourceScheduler(slots=3)
    assert scheduler.background_max == 2

    # 并发 2、3 槽位:自动 = min(2, 2) = 2
    monkeypatch.setattr(rs.settings, "material_prefetch_concurrency", 2)
    scheduler2 = rs.ResourceScheduler(slots=3)
    assert scheduler2.background_max == 2

    # 单槽位极端情况:max(1, slots-1)=1,允许 1 路后台
    # (前台仍有等待队列优先唤醒,不会被饿死)
    scheduler3 = rs.ResourceScheduler(slots=1)
    assert scheduler3.background_max == 1


def test_explicit_background_max_still_honored(monkeypatch):
    """显式设置(>0)仍按旧语义生效,兼容已有部署。"""
    monkeypatch.setattr(rs.settings, "resource_background_max_slots", 1)
    scheduler = rs.ResourceScheduler(slots=3)
    assert scheduler.background_max == 1


def test_prefetch_lane_budget_scales_with_concurrency():
    """v1.3.13 产能坡道按并发等比缩放,替代硬编码 3/2/1。

    旧硬编码按默认并发 2 设计:并发调到 8 后同路仍最多起 3 个任务,
    预取产能被锁死,跟不上 3 秒/张的用户节奏。
    v1.3.13 二次调整:半水以下全速(稳态缺缓冲即全速),
    实测旧档位让供应商侧并发被钉在 round(8*0.625)=5。
    """
    from app.services import prefetch_service as ps

    def budget(concurrency, ready, target=30):
        configured = max(1, concurrency)
        if ready < target // 2:
            return configured
        if ready < (target * 3) // 4:
            return max(1, round(configured * 0.625))
        return max(1, round(configured * 0.375))

    # 并发 8:半水以下全速 8 / 3/4 水位 5 / 近满 3
    assert [budget(8, r) for r in (0, 3, 15, 22)] == [8, 8, 5, 3]
    # 并发 ≤3:与旧硬编码 3/2/1 兼容(全速档等价)
    assert [budget(3, r) for r in (0, 15, 22)] == [3, 2, 1]
    assert [budget(2, r) for r in (0, 15, 22)] == [2, 1, 1]
    assert [budget(1, r) for r in (0, 15, 22)] == [1, 1, 1]
    # 源码中不得再出现旧硬编码坡道与整队 gather 等待
    import inspect

    src = inspect.getsource(ps.PrefetchWorker._fill_window)
    assert "3 if ready_count" not in src, "硬编码坡道已由 lane_budget 替代"
    assert "asyncio.gather(*tasks" not in src, (
        "补位不得整队等待最慢者(发射后即回+完成回调补位)"
    )
