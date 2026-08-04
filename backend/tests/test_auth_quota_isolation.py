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
    ExcelTemplate,
    MaterialBatch,
    MaterialItem,
    SpecimenRecord,
    User,
    WorkflowUsage,
)
from app.services import prefetch_service, quota_service, recognition_service


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
        json={"fields": {"产地3": "Alice location"}},
    )
    assert own_update.status_code == 200
    assert own_update.json()["fields"]["产地3"] == "Alice location"
    assert alice.patch(
        "/api/records/2",
        headers={"X-CSRF-Token": alice_csrf},
        json={"fields": {"产地3": "Forbidden"}},
    ).status_code == 404

    admin = TestClient(app)
    admin_csrf = _login(admin, "admin", "admin-password-123")
    managed_update = admin.patch(
        "/api/records/2",
        headers={
            "X-CSRF-Token": admin_csrf,
            "X-Owner-ID": "3",
        },
        json={"fields": {"产地3": "Admin managed location"}},
    )
    assert managed_update.status_code == 200
    assert managed_update.json()["fields"]["产地3"] == "Admin managed location"


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


def test_template_and_image_assets_are_owner_scoped(auth_env, tmp_path):
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

    _login(client, "alice", "alice-password-123")
    assert client.get("/api/templates/current").json()["original_filename"] == "alice.xlsx"
    assert client.get(f"/api/recognition/image/{alice_image.name}").content == b"alice"
    assert client.get(f"/api/recognition/image/{bob_image.name}").status_code == 404


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
    assert versions == [1, 2, 3]
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
    assert owner == admin_id
    assert versions == [1, 2, 3]
    assert "uq_specimen_owner_tuxiang_completed" in indexes
    backups = list(tmp_path.glob("legacy.db.backup-*"))
    assert len(backups) == 1
    migrate(engine)
    assert list(tmp_path.glob("legacy.db.backup-*")) == backups


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
