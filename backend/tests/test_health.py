"""健康检查接口测试。"""
from fastapi.testclient import TestClient

from app.main import app
from app.version import APP_CAPABILITIES, APP_PRODUCT, APP_VERSION


def test_health() -> None:
    """健康检查返回前端兼容性握手所需的版本与能力。"""
    client = TestClient(app)
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json() == {
        "status": "ok",
        "product": APP_PRODUCT,
        "app": "昆虫标本图片识别与Excel录入工作台",
        "version": APP_VERSION,
        "capabilities": list(APP_CAPABILITIES),
    }
    assert APP_VERSION == "v1.3.6"
    assert APP_PRODUCT == "insect-specimen-workbench"
    assert "agent_workflows_v1" in APP_CAPABILITIES
    assert "image_previews_v1" in APP_CAPABILITIES
    assert "resource_scheduling_v1" in APP_CAPABILITIES
    assert app.version == APP_VERSION
