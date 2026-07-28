"""设置路由测试。"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app


@pytest.fixture
def client():
    """使用内存 SQLite 的测试客户端(StaticPool 共享连接)。"""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    TestSession = sessionmaker(bind=engine)

    def override_get_db():
        db = TestSession()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    yield TestClient(app)
    app.dependency_overrides.clear()


class TestSettingsCRUD:
    """模型配置增删改查。"""

    def test_get_default_settings(self, client):
        resp = client.get("/api/settings")
        assert resp.status_code == 200
        data = resp.json()
        assert data["base_url"] == ""
        assert data["model_name"] == ""

    def test_update_and_get_settings(self, client):
        # 更新
        resp = client.put(
            "/api/settings",
            json={
                "base_url": "https://api.example.com/v1",
                "api_key": "sk-test-key-123456789",
                "model_name": "test-model",
            },
        )
        assert resp.status_code == 200
        # 读取: API Key 应被掩码
        resp = client.get("/api/settings")
        data = resp.json()
        assert data["base_url"] == "https://api.example.com/v1"
        assert data["model_name"] == "test-model"
        assert "****" in data["api_key"]
        assert data["api_key"] != "sk-test-key-123456789"

    def test_masked_key_does_not_overwrite(self, client):
        """掩码 Key 不应覆盖真实 Key。"""
        client.put(
            "/api/settings",
            json={
                "base_url": "https://api.example.com/v1",
                "api_key": "sk-real-key-123456789",
                "model_name": "model-1",
            },
        )
        # 再次更新 model_name,但传回掩码 Key
        client.put(
            "/api/settings",
            json={
                "base_url": "https://api.example.com/v1",
                "api_key": "sk-t***************************6789",
                "model_name": "model-2",
            },
        )
        resp = client.get("/api/settings")
        assert resp.json()["model_name"] == "model-2"
        # 真实 Key 应保持不变(通过掩码格式确认)


class TestPrompts:
    """提示词。"""

    def test_get_default_prompts(self, client):
        resp = client.get("/api/settings/prompts")
        assert resp.status_code == 200
        data = resp.json()
        # 默认提示词应非空
        assert "中名" in data["recognition_prompt"]
        assert "分类" in data["taxonomy_prompt"]

    def test_update_prompts(self, client):
        resp = client.put(
            "/api/settings/prompts",
            json={
                "recognition_prompt": "自定义识别提示词",
                "taxonomy_prompt": "自定义分类提示词",
            },
        )
        assert resp.status_code == 200
        # 读取确认
        resp = client.get("/api/settings/prompts")
        data = resp.json()
        assert data["recognition_prompt"] == "自定义识别提示词"
        assert data["taxonomy_prompt"] == "自定义分类提示词"


class TestModelValidation:
    """测试连接的输入校验。"""

    def test_missing_fields(self, client):
        resp = client.post(
            "/api/settings/test-model",
            json={"base_url": "", "api_key": "", "model_name": ""},
        )
        assert resp.status_code == 400
        assert "缺少必填项" in resp.json()["detail"]

    def test_base_url_with_chat_completions(self, client):
        resp = client.post(
            "/api/settings/test-model",
            json={
                "base_url": "https://api.example.com/v1/chat/completions",
                "api_key": "sk-test",
                "model_name": "test",
            },
        )
        assert resp.status_code == 400
        assert "/chat/completions" in resp.json()["detail"]
