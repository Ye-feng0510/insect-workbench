"""v1.3.12 摄取链路锁冲突韧性测试。

覆盖:
- 进度写入撞锁 → run_write_with_retry 重试成功
- 标准化周期进度提交撞锁 → 放弃本次但不误降级(批次仍 completed)
- 摄取线程异常退出 → 兜底守卫强写终态,不残留 processing
- 看门狗:陈旧 processing 任务自动回收放行上传;新鲜任务仍拦截;
  开关关闭时不回收

复用 test_materials.materials_client 夹具(含 SessionLocal 隔离)。
"""
from datetime import datetime, timedelta
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session as OrmSession

from app.models import (
    INGEST_STATUS_FAILED,
    INGEST_STATUS_PROCESSING,
    MaterialBatch,
    MaterialIngestJob,
)
from app.services import material_ingest_service as ingest_service
from tests.test_materials import materials_client  # noqa: F401 夹具复用
from tests.test_material_standardize import _big_image_bytes, _zip


def _lock_error() -> OperationalError:
    """构造 WAL 快照过期型锁错误(立即失败,busy_timeout 无效)。"""
    return OperationalError("UPDATE material_ingest_jobs", {}, Exception("database is locked"))


def _make_job(TestSession, owner_id: int = 1, status: str = INGEST_STATUS_PROCESSING) -> int:
    db = TestSession()
    job = MaterialIngestJob(
        owner_id=owner_id,
        original_filename="t.zip",
        source_path="unused",
        status=status,
    )
    db.add(job)
    db.commit()
    job_id = job.id
    db.close()
    return job_id


def _flaky_commit(monkeypatch, fail_on: int = 1):
    """让第 fail_on 次 Session.commit 抛锁错误,之后恢复真实提交。

    返回计数器 dict,供断言重试确实发生。
    """
    real_commit = OrmSession.commit
    state = {"calls": 0, "injected": 0}

    def flaky(self, *args, **kwargs):
        state["calls"] += 1
        if state["injected"] < fail_on and state["calls"] == fail_on:
            state["injected"] += 1
            raise _lock_error()
        return real_commit(self, *args, **kwargs)

    monkeypatch.setattr(OrmSession, "commit", flaky)
    return state


# ============================================================
# 1. 进度写入锁重试
# ============================================================

def test_update_progress_retries_on_transient_lock(materials_client, monkeypatch):
    """首次 commit 撞锁 → 重试整段(新会话新快照)成功,进度落地。"""
    client, TestSession = materials_client
    job_id = _make_job(TestSession)

    state = _flaky_commit(monkeypatch, fail_on=1)
    ingest_service._update_progress(job_id, 10, 100, TestSession)
    monkeypatch.undo()

    assert state["injected"] == 1, "应注入过一次锁错误"
    db = TestSession()
    job = db.get(MaterialIngestJob, job_id)
    db.close()
    assert job.processed_count == 10
    assert job.total_planned == 100
    assert job.status == INGEST_STATUS_PROCESSING


def test_set_job_stage_retries_on_transient_lock(materials_client, monkeypatch):
    """阶段写入同样具备锁重试能力。"""
    client, TestSession = materials_client
    job_id = _make_job(TestSession)

    state = _flaky_commit(monkeypatch, fail_on=1)
    ingest_service._set_job_stage(job_id, "standardizing", TestSession)
    monkeypatch.undo()

    db = TestSession()
    job = db.get(MaterialIngestJob, job_id)
    db.close()
    assert job.stage == "standardizing"


# ============================================================
# 2. 标准化周期提交容错(不误降级)
# ============================================================

def test_standardize_periodic_commit_lock_does_not_degrade(materials_client, monkeypatch):
    """周期进度提交撞锁 → 放弃本次继续,批次终态仍 completed。"""
    client, TestSession = materials_client
    files = {f"img{i}.jpg": _big_image_bytes(2000, 1500) for i in range(6)}
    response = client.post(
        "/api/materials/upload",
        files={"file": ("lock.zip", _zip(files), "application/zip")},
    )
    assert response.status_code == 202, response.text
    job_id = response.json()["job_id"]
    for _ in range(600):
        payload = client.get(f"/api/materials/ingest/{job_id}").json()
        if payload["status"] in ("completed", "failed"):
            break
        import time as _t
        _t.sleep(0.05)
    assert payload["status"] == "completed", payload

    # 重置为待标准化,直接调用 standardize_batch 并注入一次锁错误。
    # 提交序列:initial(1) → 周期 index5(2,注入点) → index6(3) → 终态(4+)
    db = TestSession()
    batch = db.query(MaterialBatch).one()
    batch.preprocess_status = "pending"
    db.commit()
    batch_id = batch.id
    db.close()

    from app.services import material_standardize_service

    state = _flaky_commit(monkeypatch, fail_on=2)
    stats = material_standardize_service.standardize_batch(batch_id, TestSession)
    monkeypatch.undo()

    assert state["injected"] == 1
    assert stats["processed"] == 6
    db = TestSession()
    final = db.get(MaterialBatch, batch_id)
    db.close()
    assert final.preprocess_status == "completed"
    assert final.preprocessed_count == 6


# ============================================================
# 3. 线程退出兜底
# ============================================================

def test_run_job_thread_guard_writes_failed_terminal(materials_client, monkeypatch):
    """线程内异常逃逸 → 兜底守卫强写 failed,job 不残留 processing。"""
    client, TestSession = materials_client
    job_id = _make_job(TestSession)

    def boom(*args, **kwargs):
        raise RuntimeError("simulated thread crash")

    monkeypatch.setattr(ingest_service, "_process_job", boom)
    # 生产语义:线程内异常继续传播(threading excepthook 打印),守卫在
    # finally 中先行落地终态
    import pytest

    with pytest.raises(RuntimeError):
        ingest_service._run_job_thread(job_id, Path("unused"), "t.zip", 1, TestSession)

    db = TestSession()
    job = db.get(MaterialIngestJob, job_id)
    db.close()
    assert job.status == INGEST_STATUS_FAILED
    assert "异常退出" in job.error_message


# ============================================================
# 4. 看门狗
# ============================================================

def test_has_active_job_reaps_stale_processing_job(materials_client):
    """updated_at 超阈值的 processing 任务被回收,上传放行。"""
    client, TestSession = materials_client
    job_id = _make_job(TestSession)
    two_hours_ago = (datetime.utcnow() - timedelta(hours=2)).strftime(
        "%Y-%m-%d %H:%M:%S"
    )
    db = TestSession()
    db.execute(
        text(
            "UPDATE material_ingest_jobs SET updated_at = :t WHERE id = :i"
        ),
        {"t": two_hours_ago, "i": job_id},
    )
    db.commit()
    db.close()

    assert ingest_service.has_active_job(TestSession(), 1) is False
    db = TestSession()
    job = db.get(MaterialIngestJob, job_id)
    db.close()
    assert job.status == INGEST_STATUS_FAILED
    assert "回收" in job.error_message


def test_has_active_job_blocks_fresh_processing_job(materials_client):
    """新鲜 processing 任务照常拦截上传(看门狗不误伤)。"""
    client, TestSession = materials_client
    _make_job(TestSession)
    assert ingest_service.has_active_job(TestSession(), 1) is True


def test_watchdog_disabled_keeps_blocking(materials_client, monkeypatch):
    """stale_seconds=0 关闭看门狗:陈旧任务仍拦截(显式退出)。"""
    client, TestSession = materials_client
    job_id = _make_job(TestSession)
    two_hours_ago = (datetime.utcnow() - timedelta(hours=2)).strftime(
        "%Y-%m-%d %H:%M:%S"
    )
    db = TestSession()
    db.execute(
        text("UPDATE material_ingest_jobs SET updated_at = :t WHERE id = :i"),
        {"t": two_hours_ago, "i": job_id},
    )
    db.commit()
    db.close()

    monkeypatch.setattr(ingest_service.settings, "material_ingest_stale_job_seconds", 0)
    assert ingest_service.has_active_job(TestSession(), 1) is True
