"""后端测试占位:验证 pytest 可导入 app。"""
from fastapi.testclient import TestClient

from app.main import app


def test_health() -> None:
    """健康检查接口返回 ok。"""
    client = TestClient(app)
    resp = client.get("/api/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
