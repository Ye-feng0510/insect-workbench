"""素材存储生命周期服务测试:预算、临时清理、旧批次安全清理。"""
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.models import (
    MATERIAL_STATUS_PENDING,
    ROLE_ADMIN,
    MaterialBatch,
    MaterialItem,
    MaterialPrefetchResult,
    PREFETCH_STATUS_READY,
    User,
)
from app.services import material_storage_service as mss


@pytest.fixture
def db_session():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    TestSession = sessionmaker(bind=engine)
    session = TestSession()
    session.add(
        User(
            id=1,
            username="test-admin",
            password_hash="test-only",
            role=ROLE_ADMIN,
            workflow_quota=None,
        )
    )
    session.commit()
    yield session
    session.close()


def _make_batch(db, owner_id, active, extract_dir, zip_path, with_items=False, referenced=False):
    batch = MaterialBatch(
        owner_id=owner_id,
        original_filename="t.zip",
        stored_zip_path=str(zip_path),
        extract_dir=str(extract_dir),
        total_count=1,
        is_active=active,
    )
    db.add(batch)
    db.flush()
    if with_items:
        item = MaterialItem(
            batch_id=batch.id,
            sequence=1,
            original_filename="a.jpg",
            archive_path="a.jpg",
            stored_path=str(Path(extract_dir) / "a.jpg"),
            status=MATERIAL_STATUS_PENDING,
            record_id=999 if referenced else None,
        )
        db.add(item)
        db.flush()
        if not referenced:
            db.add(MaterialPrefetchResult(
                batch_id=batch.id, item_id=item.id,
                status=PREFETCH_STATUS_READY, config_fingerprint="fp",
            ))
            db.flush()
    return batch


def test_cleanup_inactive_batches_removes_unreferenced(db_session, tmp_path, monkeypatch):
    """无引用的旧批次:行与文件全部清理。"""
    extract = tmp_path / "batch_old"
    extract.mkdir()
    (extract / "material_x.jpg").write_bytes(b"x")
    zip_file = tmp_path / "old.zip"
    zip_file.write_bytes(b"z")

    _make_batch(
        db_session, 1, active=False,
        extract_dir=extract, zip_path=zip_file, with_items=True,
    )
    db_session.commit()
    monkeypatch.setattr(mss.settings, "material_archive_retention_days", 0)

    result = mss.cleanup_inactive_batches(db_session)

    assert result["removed_batches"] == 1
    assert not extract.exists()
    assert not zip_file.exists()
    assert db_session.query(MaterialBatch).count() == 0
    assert db_session.query(MaterialItem).count() == 0
    assert db_session.query(MaterialPrefetchResult).count() == 0


def test_cleanup_keeps_referenced_batches(db_session, tmp_path, monkeypatch):
    """被记录引用的批次:保留批次与解压图片,仅删除 ZIP。"""
    extract = tmp_path / "batch_ref"
    extract.mkdir()
    (extract / "material_y.jpg").write_bytes(b"y")
    zip_file = tmp_path / "ref.zip"
    zip_file.write_bytes(b"z")

    _make_batch(
        db_session, 1, active=False,
        extract_dir=extract, zip_path=zip_file,
        with_items=True, referenced=True,
    )
    db_session.commit()
    monkeypatch.setattr(mss.settings, "material_archive_retention_days", 0)

    result = mss.cleanup_inactive_batches(db_session)

    assert result["kept_referenced"] == 1
    assert result["removed_batches"] == 0
    assert result["removed_zips"] == 1
    assert extract.exists(), "被引用批次的解压图片必须保留"
    assert not zip_file.exists()
    batch = db_session.query(MaterialBatch).one()
    assert batch.stored_zip_path == ""


def test_cleanup_respects_retention_window(db_session, tmp_path, monkeypatch):
    """保留期内的旧批次暂不清理。"""
    extract = tmp_path / "batch_new"
    extract.mkdir()
    zip_file = tmp_path / "new.zip"

    _make_batch(
        db_session, 1, active=False,
        extract_dir=extract, zip_path=zip_file, with_items=True,
    )
    db_session.commit()
    # created_at 由服务器默认值生成,这里显式回拨到窗口内(1 天前 < 7 天保留期)
    batch = db_session.query(MaterialBatch).one()
    batch.created_at = datetime.utcnow() - timedelta(days=1)
    db_session.commit()
    monkeypatch.setattr(mss.settings, "material_archive_retention_days", 7)

    result = mss.cleanup_inactive_batches(db_session)

    assert result["removed_batches"] == 0
    assert extract.exists()


def test_cleanup_stale_incoming_zips_by_age(tmp_path):
    """超时的 incoming_*.zip 被清理,新文件保留。"""
    from app.config import MATERIAL_ZIPS_DIR

    old = MATERIAL_ZIPS_DIR / "incoming_old.zip"
    new = MATERIAL_ZIPS_DIR / "incoming_new.zip"
    old.write_bytes(b"old")
    new.write_bytes(b"new")
    try:
        old_mtime = datetime.utcnow() - timedelta(hours=48)
        import os

        os.utime(old, (old_mtime.timestamp(), old_mtime.timestamp()))
        removed = mss.cleanup_stale_incoming_zips(max_age_hours=24)
        assert removed == 1
        assert not old.exists()
        assert new.exists()
    finally:
        old.unlink(missing_ok=True)
        new.unlink(missing_ok=True)


def test_upload_budget_rejects_when_projected_low(monkeypatch):
    """预计上传后磁盘不足时拒绝。"""

    class FakeUsage:
        free = 6 * 1024**3

    import shutil as _shutil

    monkeypatch.setattr(_shutil, "disk_usage", lambda _p: FakeUsage())
    monkeypatch.setattr(mss.settings, "material_storage_min_free_gb", 5.0)
    monkeypatch.setattr(mss.settings, "material_storage_warn_free_gb", 10.0)

    # 预算 = zip + zip*2.5;6GB - 3.5x*zip < 5GB 当 zip >= 400MB
    with __import__("pytest").raises(mss.StorageBudgetError):
        mss.check_upload_budget(500 * 1024**2)


def test_upload_budget_allows_ample_space(monkeypatch):
    class FakeUsage:
        free = 100 * 1024**3

    import shutil as _shutil

    monkeypatch.setattr(_shutil, "disk_usage", lambda _p: FakeUsage())
    info = mss.check_upload_budget(1024**3)
    assert info["projected_free_bytes"] > 0
    assert not info["warn"]


def test_extract_dir_guard_rejects_outside_paths():
    from app.config import MATERIAL_IMAGES_DIR, MATERIAL_ZIPS_DIR

    assert mss.enforce_extract_dir_guard(MATERIAL_IMAGES_DIR / "batch_x")
    assert not mss.enforce_extract_dir_guard(MATERIAL_ZIPS_DIR / "evil")
