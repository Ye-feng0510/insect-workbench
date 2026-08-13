from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from app.auth import hash_password
from app.database import Base
from app.models import ROLE_ADMIN, ROLE_USER


@pytest.fixture
def auth_env():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    TestSession = sessionmaker(bind=engine)
    with TestSession() as db:
        db.add_all(
            [
                User(
                    id=1,
                    username="admin",
                    password_hash=hash_password("admin-password-123"),
                    role=ROLE_ADMIN,
                ),
                User(
                    id=2,
                    username="alice",
                    password_hash=hash_password("alice-password-123"),
                    role=ROLE_USER,
                    workflow_quota=2,
                ),
                User(
                    id=3,
                    username="bob",
                    password_hash=hash_password("bob-password-123"),
                    role=ROLE_USER,
                    workflow_quota=2,
                ),
            ]
        )
        db.add_all([
            SpecimenRecord(owner_id=2, image_filename="alice.jpg"),
            SpecimenRecord(owner_id=3, image_filename="bob.jpg"),
        ])
        db.commit()
    return TestSession

from app.models import (
    DeletedAccountAudit,
    ExcelTemplate,
    ExportArtifact,
    MaterialBatch,
    MaterialItem,
    SpecimenRecord,
    WorkflowUsage,
    User,
    USAGE_CHARGED,
    USAGE_RELEASED,
)
from app.services.admin_data_service import get_data_summary, reset_user_data
from app.services.admin_data_service import delete_user_account


def test_admin_reset_preserves_account_templates_and_charged_audit(
    auth_env, tmp_path: Path
):
    TestSession = auth_env
    image = tmp_path / "record.jpg"
    zip_path = tmp_path / "batch.zip"
    extract_dir = tmp_path / "batch"
    export_path = tmp_path / "export.xlsx"
    template_path = tmp_path / "template.xlsx"
    for path in (image, zip_path, export_path, template_path):
        path.write_bytes(b"data")
    extract_dir.mkdir()
    (extract_dir / "material.jpg").write_bytes(b"material")

    with TestSession() as db:
        record = db.query(SpecimenRecord).filter_by(owner_id=2).one()
        record.image_path = str(image)
        db.add(
            ExcelTemplate(
                owner_id=2,
                original_filename="template.xlsx",
                stored_path=str(template_path),
                is_active=True,
            )
        )
        batch = MaterialBatch(
            owner_id=2,
            original_filename="batch.zip",
            stored_zip_path=str(zip_path),
            extract_dir=str(extract_dir),
            total_count=1,
        )
        db.add(batch)
        db.flush()
        db.add(
            MaterialItem(
                batch_id=batch.id,
                sequence=1,
                original_filename="material.jpg",
                archive_path="material.jpg",
                stored_path=str(extract_dir / "material.jpg"),
            )
        )
        db.add(
            ExportArtifact(
                owner_id=2,
                filename="export.xlsx",
                stored_path=str(export_path),
                created_by_user_id=1,
            )
        )
        db.add_all(
            [
                WorkflowUsage(
                    owner_id=2,
                    record_id=record.id,
                    status=USAGE_CHARGED,
                ),
                WorkflowUsage(
                    owner_id=2,
                    record_id=None,
                    status=USAGE_RELEASED,
                ),
            ]
        )
        db.commit()
        charged_before = db.get(User, 2).workflow_charged
        result = reset_user_data(
            db,
            2,
            records=True,
            materials=True,
            workflows=True,
            taxonomy=True,
            exports=False,
        )
        assert result["failed_paths"] == []
        assert not image.exists()
        assert not zip_path.exists()
        assert not extract_dir.exists()
        assert export_path.exists()
        assert template_path.exists()
        assert db.query(SpecimenRecord).filter_by(owner_id=2).count() == 0
        assert db.query(MaterialBatch).filter_by(owner_id=2).count() == 0
        charged = db.query(WorkflowUsage).filter_by(
            owner_id=2, status=USAGE_CHARGED
        ).one()
        assert charged.record_id is None
        assert db.query(WorkflowUsage).filter_by(
            owner_id=2, status=USAGE_RELEASED
        ).count() == 0
        assert charged_before == 0
        assert get_data_summary(db, 3)["records"] == 1


def test_delete_user_account_removes_user_data_and_keeps_audit(
    auth_env, tmp_path: Path
):
    TestSession = auth_env
    image = tmp_path / "record.jpg"
    image.write_bytes(b"record")
    with TestSession() as db:
        record = db.query(SpecimenRecord).filter_by(owner_id=2).one()
        record.image_path = str(image)
        db.add(WorkflowUsage(
            owner_id=2,
            record_id=record.id,
            status=USAGE_CHARGED,
        ))
        db.commit()
        result = delete_user_account(db, 2, 1)
        assert result["username"] == "alice"
        assert not image.exists()
        assert db.get(User, 2) is None
        assert db.query(SpecimenRecord).filter_by(owner_id=2).count() == 0
        assert db.query(WorkflowUsage).filter_by(owner_id=2).count() == 0
        audit = db.query(DeletedAccountAudit).one()
        assert audit.username == "alice"
        assert audit.charged_usage_count == 1
        assert db.get(User, 3) is not None


def test_delete_user_account_rejects_current_admin(auth_env):
    TestSession = auth_env
    with TestSession() as db:
        with pytest.raises(ValueError, match="当前管理员"):
            delete_user_account(db, 1, 1)
