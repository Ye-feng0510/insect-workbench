"""Authentication, RBAC, owner isolation, quota, and migration coverage."""
import asyncio
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.auth import get_auth_context, hash_password
from app.database import Base, get_db
from app.main import app
from app.migrations import migrate
from app.models import (
    ROLE_ADMIN,
    ROLE_USER,
    STATUS_AWAITING_CONFIRMATION,
    AppSettings,
    ExcelTemplate,
    MaterialBatch,
    MaterialItem,
    SpecimenRecord,
    User,
    WorkflowUsage,
)
from app.services import (
    materials_service,
    prefetch_service,
    quota_service,
    recognition_service,
)


@pytest.fixture
def auth_env():
    app.dependency_overrides.pop(get_auth_context, None)
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
                    workflow_quota=None,
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
        db.add_all(
            [
                SpecimenRecord(
                    owner_id=2,
                    image_filename="alice.jpg",
                    status=STATUS_AWAITING_CONFIRMATION,
                ),
                SpecimenRecord(
                    owner_id=3,
                    image_filename="bob.jpg",
                    status=STATUS_AWAITING_CONFIRMATION,
                ),
            ]
        )
        db.commit()

    def override_db():
        with TestSession() as db:
            yield db

    app.dependency_overrides[get_db] = override_db
    yield TestClient(app), TestSession
    app.dependency_overrides.pop(get_db, None)


def _login(client: TestClient, username: str, password: str) -> str:
    response = client.post(
        "/api/auth/login",
        json={"username": username, "password": password},
    )
    assert response.status_code == 200
    return response.json()["csrf_token"]


def test_login_csrf_logout_and_rbac(auth_env):
    client, _ = auth_env
    assert client.get("/api/records").status_code == 401
    csrf = _login(client, "alice", "alice-password-123")
    assert client.get("/api/auth/me").json()["username"] == "alice"
    assert client.get("/api/settings").status_code == 403
    assert client.delete("/api/records/1").status_code == 403
    assert client.delete(
        "/api/records/1", headers={"X-CSRF-Token": csrf}
    ).status_code == 200
    assert client.post("/api/auth/logout").status_code == 403
    assert client.post(
        "/api/auth/logout", headers={"X-CSRF-Token": csrf}
    ).status_code == 200
    assert client.get("/api/auth/me").status_code == 401


def test_session_and_csrf_cookies_restore_an_unsafe_request(auth_env):
    client, _ = auth_env
    response = client.post(
        "/api/auth/login",
        json={"username": "alice", "password": "alice-password-123"},
    )
    assert response.status_code == 200
    assert response.cookies["insect_session"]
    assert response.cookies["insect_csrf"] == response.json()["csrf_token"]

    restored = TestClient(app)
    restored.cookies.update(client.cookies)
    assert restored.get("/api/auth/me").status_code == 200
    csrf = restored.cookies["insect_csrf"]
    assert restored.delete(
        "/api/records/1",
        headers={"X-CSRF-Token": csrf},
    ).status_code == 200


def test_login_failures_are_rate_limited(auth_env, monkeypatch):
    from app.routers import auth as auth_router

    client, _ = auth_env
    auth_router._failed_logins.clear()
    monkeypatch.setattr(auth_router.settings, "auth_login_max_failures", 2)
    for _ in range(2):
        assert client.post(
            "/api/auth/login",
            json={"username": "missing", "password": "wrong-password"},
        ).status_code == 401
    response = client.post(
        "/api/auth/login",
        json={"username": "missing", "password": "wrong-password"},
    )
    assert response.status_code == 429
    assert response.headers["Retry-After"]
    auth_router._failed_logins.clear()


def test_owner_isolation_and_admin_explicit_selection(auth_env):
    alice = TestClient(app)
    _login(alice, "alice", "alice-password-123")
    records = alice.get("/api/records").json()
    assert [row["image_filename"] for row in records] == ["alice.jpg"]
    assert alice.get("/api/records", headers={"X-Owner-ID": "3"}).status_code == 403
    assert alice.get("/api/records/2").status_code == 404

    admin = TestClient(app)
    _login(admin, "admin", "admin-password-123")
    bob_records = admin.get(
        "/api/records", headers={"X-Owner-ID": "3"}
    ).json()
    assert [row["image_filename"] for row in bob_records] == ["bob.jpg"]
    assert admin.get(
        "/api/records", headers={"X-Owner-ID": "999"}
    ).status_code == 422


def test_record_edit_respects_user_and_admin_owner_context(auth_env):
    """普通用户只能编辑自己记录,管理员可编辑明确选择的所有者记录。"""
    alice = TestClient(app)
    alice_csrf = _login(alice, "alice", "alice-password-123")
    own_update = alice.patch(
        "/api/records/1",
        headers={"X-CSRF-Token": alice_csrf},
        json={"fields": {"产地3": "Alice location", "鉴定人": "Alice expert"}},
    )
    assert own_update.status_code == 200
    assert own_update.json()["fields"]["产地3"] == "Alice location"
    assert own_update.json()["fields"]["鉴定人"] == "Alice expert"
    assert alice.patch(
        "/api/records/2",
        headers={"X-CSRF-Token": alice_csrf},
        json={"fields": {"鉴定人": "Forbidden"}},
    ).status_code == 404

    admin = TestClient(app)
    admin_csrf = _login(admin, "admin", "admin-password-123")
    managed_update = admin.patch(
        "/api/records/2",
        headers={
            "X-CSRF-Token": admin_csrf,
            "X-Owner-ID": "3",
        },
        json={"fields": {"产地3": "Admin managed location", "鉴定人": "Admin expert"}},
    )
    assert managed_update.status_code == 200
    assert managed_update.json()["fields"]["产地3"] == "Admin managed location"
    assert managed_update.json()["fields"]["鉴定人"] == "Admin expert"


def test_taxonomy_cache_is_owner_scoped(auth_env):
    _, TestSession = auth_env
    alice_taxonomy = {
        "Phylum": "Arthropoda",
        "纲": "昆虫纲",
        "Class": "Insecta",
        "Order": "Coleoptera",
        "中文科名": "瓢虫科",
        "科名": "Coccinellidae",
        "属名": "Harmonia",
        "种名": "axyridis",
    }
    bob_taxonomy = {**alice_taxonomy, "Order": "Hemiptera"}
    with TestSession() as db:
        recognition_service._update_taxonomy_cache(
            db, 2, "同名昆虫", alice_taxonomy
        )
        recognition_service._update_taxonomy_cache(
            db, 3, "同名昆虫", bob_taxonomy
        )
        db.commit()
        assert recognition_service._query_taxonomy_cache(
            db, 2, "同名昆虫"
        )["Order"] == "Coleoptera"
        assert recognition_service._query_taxonomy_cache(
            db, 3, "同名昆虫"
        )["Order"] == "Hemiptera"


def test_template_and_image_assets_are_owner_scoped(
    auth_env, tmp_path, monkeypatch
):
    client, TestSession = auth_env
    alice_image = tmp_path / "alice-image.jpg"
    bob_image = tmp_path / "bob-image.jpg"
    alice_image.write_bytes(b"alice")
    bob_image.write_bytes(b"bob")
    with TestSession() as db:
        db.add_all(
            [
                ExcelTemplate(
                    owner_id=2,
                    original_filename="alice.xlsx",
                    stored_path=str(tmp_path / "alice.xlsx"),
                    is_active=True,
                ),
                ExcelTemplate(
                    owner_id=3,
                    original_filename="bob.xlsx",
                    stored_path=str(tmp_path / "bob.xlsx"),
                    is_active=True,
                ),
            ]
        )
        alice_record = db.query(SpecimenRecord).filter_by(owner_id=2).one()
        alice_record.image_filename = alice_image.name
        alice_record.image_path = str(alice_image)
        bob_record = db.query(SpecimenRecord).filter_by(owner_id=3).one()
        bob_record.image_filename = bob_image.name
        bob_record.image_path = str(bob_image)
        db.commit()
        alice_record_id = alice_record.id
        bob_record_id = bob_record.id

    _login(client, "alice", "alice-password-123")
    assert client.get("/api/templates/current").json()["original_filename"] == "alice.xlsx"
    assert client.get(f"/api/recognition/image/{alice_image.name}").content == b"alice"
    assert client.get(
        f"/api/recognition/{alice_record_id}/image"
    ).content == b"alice"
    assert client.get(
        f"/api/records/{alice_record_id}"
    ).json()["image_url"] == f"/api/recognition/{alice_record_id}/image"
    assert client.get(
        "/api/recognition/active-draft"
    ).json()["image_url"] == f"/api/recognition/{alice_record_id}/image"
    assert client.get(f"/api/recognition/image/{bob_image.name}").status_code == 404
    assert client.get(
        f"/api/recognition/{bob_record_id}/image"
    ).status_code == 404

    current_images = tmp_path / "current-images"
    current_images.mkdir()
    current_fallback = current_images / "relocated.jpg"
    current_fallback.write_bytes(b"current")
    monkeypatch.setattr(materials_service, "IMAGES_DIR", current_images)
    with TestSession() as db:
        alice_record = db.get(SpecimenRecord, alice_record_id)
        alice_record.image_path = str(tmp_path / "old" / "relocated.jpg")
        batch = MaterialBatch(
            owner_id=2,
            original_filename="materials.zip",
            stored_zip_path=str(tmp_path / "materials.zip"),
            extract_dir=str(tmp_path),
            is_active=True,
        )
        db.add(batch)
        db.flush()
        material_source = tmp_path / "material-source.jpg"
        material_source.write_bytes(b"material")
        db.add(
            MaterialItem(
                batch_id=batch.id,
                sequence=1,
                original_filename="alice-image.jpg",
                archive_path="alice-image.jpg",
                stored_path=str(material_source),
                record_id=alice_record_id,
            )
        )
        db.commit()

    assert client.get(
        f"/api/recognition/{alice_record_id}/image"
    ).content == b"current"
    current_fallback.unlink()
    assert client.get(
        f"/api/recognition/{alice_record_id}/image"
    ).content == b"material"
    assert client.get(
        f"/api/recognition/image/{alice_image.name}"
    ).content == b"material"
    material_source.unlink()
    assert client.get(
        f"/api/recognition/{alice_record_id}/image"
    ).status_code == 404


def test_material_summary_uses_selected_owner_quota(auth_env):
    client, TestSession = auth_env
    with TestSession() as db:
        alice = db.get(User, 2)
        alice.workflow_reserved = 1
        alice.workflow_charged = 1
        db.commit()

    _login(client, "admin", "admin-password-123")
    admin_summary = client.get("/api/materials/summary").json()
    assert admin_summary["quota_total"] is None
    assert admin_summary["quota_remaining"] is None
    assert admin_summary["quota_exhausted"] is False

    alice_summary = client.get(
        "/api/materials/summary", headers={"X-Owner-ID": "2"}
    ).json()
    assert alice_summary["quota_total"] == 2
    assert alice_summary["quota_charged"] == 1
    assert alice_summary["quota_reserved"] == 1
    assert alice_summary["quota_remaining"] == 0
    assert alice_summary["quota_exhausted"] is True


def test_admin_user_quota_update_is_audited(auth_env):
    client, TestSession = auth_env
    csrf = _login(client, "admin", "admin-password-123")
    response = client.put(
        "/api/admin/users/2/quota",
        headers={"X-CSRF-Token": csrf},
        json={"workflow_quota": 7, "reason": "project extension"},
    )
    assert response.status_code == 200
    assert response.json()["workflow_quota"] == 7
    audit = client.get("/api/admin/quota-adjustments").json()
    assert audit[0]["user_id"] == 2
    assert audit[0]["actor_user_id"] == 1
    assert audit[0]["reason"] == "project extension"

    with TestSession() as db:
        quota_service.reserve(db, 2, 1)
        quota_service.charge(db, 1)
        db.commit()
    usage = client.get("/api/admin/users/2/usage-history").json()
    assert usage[0]["record_id"] == 1
    assert usage[0]["status"] == "charged"


def test_quota_reserve_charge_release_idempotency(tmp_path):
    engine = create_engine(
        f"sqlite:///{tmp_path / 'quota.db'}",
        connect_args={"check_same_thread": False, "timeout": 10},
    )
    Base.metadata.create_all(engine)
    Factory = sessionmaker(bind=engine)
    with Factory() as db:
        user = User(
            username="limited",
            password_hash="x",
            role=ROLE_USER,
            workflow_quota=1,
        )
        db.add(user)
        db.flush()
        db.add_all(
            [
                SpecimenRecord(owner_id=user.id),
                SpecimenRecord(owner_id=user.id),
            ]
        )
        db.commit()
        user_id = user.id
        record_ids = [
            row.id
            for row in db.query(SpecimenRecord).order_by(SpecimenRecord.id)
        ]

    def attempt(record_id):
        with Factory() as db:
            try:
                quota_service.reserve(db, user_id, record_id)
                return True
            except Exception:
                return False

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(attempt, record_ids))
    assert sorted(results) == [False, True]

    reserved_id = record_ids[results.index(True)]
    blocked_id = record_ids[results.index(False)]
    with Factory() as db:
        assert quota_service.reserve(db, user_id, reserved_id).status == "reserved"
        assert quota_service.release(db, reserved_id) is True
        assert quota_service.release(db, reserved_id) is False
        quota_service.reserve(db, user_id, blocked_id)
        assert quota_service.charge(db, blocked_id) is True
        db.commit()
        assert quota_service.charge(db, blocked_id) is False
        user = db.get(User, user_id)
        assert user.workflow_reserved == 0
        assert user.workflow_charged == 1


def _create_legacy_schema(engine) -> None:
    with engine.begin() as conn:
        conn.execute(text(
            "CREATE TABLE specimen_records ("
            "id INTEGER PRIMARY KEY, tuxiang VARCHAR(200), status VARCHAR(50))"
        ))
        conn.execute(text(
            "CREATE TABLE excel_templates ("
            "id INTEGER PRIMARY KEY, is_active BOOLEAN)"
        ))
        conn.execute(text(
            "CREATE TABLE material_batches ("
            "id INTEGER PRIMARY KEY, is_active BOOLEAN)"
        ))
        conn.execute(text(
            "INSERT INTO specimen_records(id,tuxiang,status) "
            "VALUES (1,'LEGACY-1','completed')"
        ))


@pytest.mark.parametrize(
    ("username", "password", "message"),
    [
        ("", "", "首次启动必须设置"),
        ("bootstrap", "short", "密码至少需要 12 个字符"),
    ],
)
def test_legacy_migration_validates_bootstrap_before_mutation(
    tmp_path, monkeypatch, username, password, message
):
    path = tmp_path / "legacy.db"
    engine = create_engine(f"sqlite:///{path}")
    _create_legacy_schema(engine)
    before_tables = set(inspect(engine).get_table_names())
    with engine.connect() as conn:
        before_columns = {
            row[1]
            for row in conn.execute(
                text("PRAGMA table_info('specimen_records')")
            )
        }
    monkeypatch.setattr(
        "app.migrations.settings.bootstrap_admin_username", username
    )
    monkeypatch.setattr(
        "app.migrations.settings.bootstrap_admin_password", password
    )

    with pytest.raises(RuntimeError, match=message):
        migrate(engine)

    assert set(inspect(engine).get_table_names()) == before_tables
    with engine.connect() as conn:
        after_columns = {
            row[1]
            for row in conn.execute(
                text("PRAGMA table_info('specimen_records')")
            )
        }
    assert after_columns == before_columns
    assert "owner_id" not in after_columns
    assert not list(tmp_path.glob("legacy.db.backup-*"))


def test_partial_auth_tables_resume_legacy_migration(tmp_path, monkeypatch):
    path = tmp_path / "legacy.db"
    engine = create_engine(f"sqlite:///{path}")
    _create_legacy_schema(engine)
    for table_name in ("users", "auth_sessions", "quota_adjustments"):
        Base.metadata.tables[table_name].create(engine, checkfirst=True)
    monkeypatch.setattr(
        "app.migrations.settings.bootstrap_admin_username", "bootstrap"
    )
    monkeypatch.setattr(
        "app.migrations.settings.bootstrap_admin_password",
        "bootstrap-password-123",
    )

    migrate(engine)

    with engine.connect() as conn:
        admin_id = conn.execute(
            text("SELECT id FROM users WHERE username='bootstrap'")
        ).scalar_one()
        owner_id = conn.execute(
            text("SELECT owner_id FROM specimen_records WHERE id=1")
        ).scalar_one()
        versions = conn.execute(
            text("SELECT version FROM schema_version ORDER BY version")
        ).scalars().all()
        admin_count = conn.execute(
            text("SELECT COUNT(*) FROM users WHERE username='bootstrap'")
        ).scalar_one()
    assert owner_id == admin_id
    assert versions == [1, 2, 3, 4, 5, 6]
    assert admin_count == 1
    assert len(list(tmp_path.glob("legacy.db.backup-*"))) == 1


def test_legacy_migration_assigns_bootstrap_admin(tmp_path, monkeypatch):
    path = tmp_path / "legacy.db"
    engine = create_engine(f"sqlite:///{path}")
    _create_legacy_schema(engine)
    monkeypatch.setattr(
        "app.migrations.settings.bootstrap_admin_username", "bootstrap"
    )
    monkeypatch.setattr(
        "app.migrations.settings.bootstrap_admin_password",
        "bootstrap-password-123",
    )
    migrate(engine)
    with engine.connect() as conn:
        owner = conn.execute(
            text("SELECT owner_id FROM specimen_records WHERE id=1")
        ).scalar_one()
        admin_id = conn.execute(
            text("SELECT id FROM users WHERE username='bootstrap'")
        ).scalar_one()
        versions = conn.execute(
            text("SELECT version FROM schema_version ORDER BY version")
        ).scalars().all()
        indexes = {
            row[1]
            for row in conn.execute(
                text("PRAGMA index_list('specimen_records')")
            )
        }
        columns = {
            row[1]
            for row in conn.execute(
                text("PRAGMA table_info('specimen_records')")
            )
        }
        jiandingren = conn.execute(
            text("SELECT jiandingren FROM specimen_records WHERE id=1")
        ).scalar_one()
    assert owner == admin_id
    assert versions == [1, 2, 3, 4, 5, 6]
    assert {"jiandingren", "ocr_result_json"}.issubset(columns)
    assert jiandingren == ""
    assert "uq_specimen_owner_tuxiang_completed" in indexes
    backups = list(tmp_path.glob("legacy.db.backup-*"))
    assert len(backups) == 1
    migrate(engine)
    assert list(tmp_path.glob("legacy.db.backup-*")) == backups


def test_v4_migration_backfills_existing_identifier_mapping(tmp_path):
    import json
    from openpyxl import Workbook

    path = tmp_path / "v3.db"
    workbook_path = tmp_path / "template.xlsx"
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "标本表"
    sheet.append(["中名", "图像", "鉴定人"])
    workbook.save(workbook_path)

    engine = create_engine(f"sqlite:///{path}")
    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        conn.execute(text(
            "CREATE TABLE schema_version ("
            "version INTEGER PRIMARY KEY, applied_at DATETIME NOT NULL "
            "DEFAULT CURRENT_TIMESTAMP)"
        ))
        conn.execute(text(
            "INSERT INTO schema_version(version) VALUES (1), (2), (3)"
        ))
    with Session(engine) as db:
        db.add(User(
            id=1,
            username="admin",
            password_hash=hash_password("admin-password-123"),
            role=ROLE_ADMIN,
            is_active=True,
        ))
        db.add(ExcelTemplate(
            owner_id=1,
            original_filename="template.xlsx",
            stored_path=str(workbook_path),
            target_sheet="标本表",
            header_row=1,
            start_row=2,
            base_write_row=2,
            style_source_row=2,
            field_mapping_json=json.dumps(
                {"中名": "A", "图像": "B"}, ensure_ascii=False
            ),
            is_active=True,
        ))
        db.commit()

    migrate(engine)

    with Session(engine) as db:
        mapping = json.loads(db.query(ExcelTemplate).one().field_mapping_json)
    assert mapping == {"中名": "A", "图像": "B", "鉴定人": "C"}


def test_authentic_v4_to_v6_migration_preserves_records_and_settings(tmp_path):
    path = tmp_path / "v4.db"
    engine = create_engine(f"sqlite:///{path}")
    workflow_tables = {
        "workflow_sessions",
        "workflow_messages",
        "taxonomy_resolutions",
        "taxon_concept_cache",
    }
    Base.metadata.create_all(
        engine,
        tables=[
            table
            for table in Base.metadata.sorted_tables
            if table.name not in workflow_tables
        ],
    )
    with Session(engine) as db:
        db.add(
            User(
                id=1,
                username="admin",
                password_hash=hash_password("admin-password-123"),
                role=ROLE_ADMIN,
                is_active=True,
            )
        )
        db.add(
            AppSettings(
                id=1,
                base_url="https://model.example/v1",
                api_key="preserved-test-value",
                model_name="test-model",
                recognition_prompt="preserved recognition prompt",
                taxonomy_prompt="preserved taxonomy prompt",
            )
        )
        db.add(
            SpecimenRecord(
                id=9,
                owner_id=1,
                status="completed",
                tuxiang="LEGACY-V4",
                zhongming="旧记录",
            )
        )
        db.commit()
    with engine.begin() as conn:
        conn.execute(text(
            "CREATE TABLE schema_version ("
            "version INTEGER PRIMARY KEY, applied_at DATETIME NOT NULL "
            "DEFAULT CURRENT_TIMESTAMP)"
        ))
        conn.execute(text(
            "INSERT INTO schema_version(version) VALUES (1), (2), (3), (4)"
        ))
        for column in (
            "scientific_name",
            "scientific_name_authorship",
            "subfamily",
            "tribe",
            "subgenus",
            "taxonomy_verification_json",
        ):
            conn.execute(text(f"ALTER TABLE specimen_records DROP COLUMN {column}"))

    assert workflow_tables.isdisjoint(inspect(engine).get_table_names())

    migrate(engine)
    with engine.connect() as conn:
        versions = conn.execute(
            text("SELECT version FROM schema_version ORDER BY version")
        ).scalars().all()
        record = conn.execute(
            text(
                "SELECT owner_id,zhongming,tuxiang,scientific_name "
                "FROM specimen_records WHERE id=9"
            )
        ).one()
        preserved_settings = conn.execute(
            text(
                "SELECT base_url,api_key,model_name,recognition_prompt,"
                "taxonomy_prompt FROM app_settings WHERE id=1"
            )
        ).one()
        tables = set(inspect(engine).get_table_names())
        workflow_columns = {
            column["name"]
            for column in inspect(engine).get_columns("workflow_sessions")
        }
        workflow_indexes = {
            row[1]
            for row in conn.execute(
                text("PRAGMA index_list('workflow_sessions')")
            )
        }
    assert versions == [1, 2, 3, 4, 5, 6]
    assert tuple(record) == (1, "旧记录", "LEGACY-V4", "")
    assert tuple(preserved_settings) == (
        "https://model.example/v1",
        "preserved-test-value",
        "test-model",
        "preserved recognition prompt",
        "preserved taxonomy prompt",
    )
    assert workflow_tables.issubset(tables)
    assert "result_record_id" in workflow_columns
    assert "ix_workflow_sessions_result_record_id" in workflow_indexes


def test_exhausted_user_is_skipped_by_prefetch(auth_env, monkeypatch, tmp_path):
    _, TestSession = auth_env
    with TestSession() as db:
        user = db.get(User, 2)
        user.workflow_quota = 1
        user.workflow_charged = 1
        batch = MaterialBatch(
            owner_id=2,
            original_filename="materials.zip",
            stored_zip_path=str(tmp_path / "materials.zip"),
            extract_dir=str(tmp_path),
            is_active=True,
        )
        db.add(batch)
        db.flush()
        db.add(
            MaterialItem(
                batch_id=batch.id,
                sequence=1,
                original_filename="one.jpg",
                archive_path="one.jpg",
                stored_path=str(tmp_path / "one.jpg"),
            )
        )
        db.commit()

    monkeypatch.setattr(prefetch_service, "SessionLocal", TestSession)
    monkeypatch.setattr(
        prefetch_service,
        "_get_current_fingerprint",
        lambda: "configured",
    )
    asyncio.run(prefetch_service.PrefetchWorker()._fill_window())
    with TestSession() as db:
        assert db.query(prefetch_service.MaterialPrefetchResult).count() == 0
