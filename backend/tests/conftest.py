"""Shared authenticated principal for legacy route regression tests."""
import pytest

from app.auth import AuthContext, get_auth_context
from app.main import app
from app.models import ROLE_ADMIN, User


@pytest.fixture(autouse=True)
def authenticated_admin_override():
    user = User(
        id=1,
        username="test-admin",
        password_hash="test-only",
        role=ROLE_ADMIN,
        is_active=True,
        workflow_quota=None,
        workflow_reserved=0,
        workflow_charged=0,
    )

    def override_auth():
        return AuthContext(user=user, owner_id=1, session_id=1)

    app.dependency_overrides[get_auth_context] = override_auth
    yield
    app.dependency_overrides.pop(get_auth_context, None)
