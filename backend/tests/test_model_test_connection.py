"""模型测试连接逻辑测试:xAI/Grok 像素下限兼容与错误分类。"""
import asyncio
import base64
import io

import pytest
from PIL import Image

from app.config import settings
from app.services.model_provider import ModelError, VisionModelClient


def decode_test_image_size(messages) -> tuple[int, int]:
    """从 mock 捕获的 messages 中解码测试图实际尺寸。"""
    data_url = messages[1]["content"][0]["image_url"]["url"]
    assert data_url.startswith("data:image/jpeg;base64,")
    raw = base64.b64decode(data_url.split(",", 1)[1])
    with Image.open(io.BytesIO(raw)) as img:
        return img.size


@pytest.fixture
def client():
    return VisionModelClient(
        "https://example.com/v1", "sk-test", "grok-4.5", timeout=5
    )


def make_capture_chat(captured: dict, reply: str = '{"主色调":"红色"}'):
    async def fake_chat(messages, max_tokens=2000):
        captured["messages"] = messages
        return reply
    return fake_chat


def make_error_chat(error: str):
    async def fake_chat(messages, max_tokens=2000):
        raise ModelError(error)
    return fake_chat


class TestTestImageSize:
    """测试图尺寸生成:满足 xAI >=512 像素下限。"""

    def test_default_size_meets_xai_minimum(self, client, monkeypatch):
        """默认配置 32x32=1024 像素 >= xAI 512 下限。"""
        captured = {}
        monkeypatch.setattr(client, "_chat", make_capture_chat(captured))
        ok, _ = asyncio.run(client.test_image_input())
        assert ok is True
        w, h = decode_test_image_size(captured["messages"])
        assert w * h >= 512, f"默认测试图 {w}x{h}={w*h} 像素低于 xAI 512 下限"
        assert (w, h) == (32, 32)

    def test_size_follows_configuration(self, client, monkeypatch):
        """测试图尺寸跟随 MODEL_TEST_IMAGE_SIZE 配置。"""
        monkeypatch.setattr(settings, "model_test_image_size", 64)
        captured = {}
        monkeypatch.setattr(client, "_chat", make_capture_chat(captured))
        ok, _ = asyncio.run(client.test_image_input())
        assert ok is True
        assert decode_test_image_size(captured["messages"]) == (64, 64)

    def test_undersized_config_clamped_to_512(self, client, monkeypatch):
        """配置小于下限时被钳制:16 -> 23(23x23=529>=512)。"""
        monkeypatch.setattr(settings, "model_test_image_size", 16)
        captured = {}
        monkeypatch.setattr(client, "_chat", make_capture_chat(captured))
        ok, _ = asyncio.run(client.test_image_input())
        assert ok is True
        w, h = decode_test_image_size(captured["messages"])
        assert w * h >= 512
        assert (w, h) == (23, 23)


class TestErrorClassification:
    """错误分类:像素尺寸错误不再误报为'不支持图片输入'。"""

    def test_xai_pixel_error_reports_size_issue(self, client, monkeypatch):
        """xAI 像素下限错误文案 -> 提示尺寸过小,而非不支持图片输入。"""
        xai_error = (
            "模型接口返回 HTTP 400: Image has 100 total pixels (10x10), "
            "which is below the minimum of 512 pixels."
        )
        monkeypatch.setattr(client, "_chat", make_error_chat(xai_error))
        ok, msg = asyncio.run(client.test_image_input())
        assert ok is False
        assert "尺寸过小" in msg
        assert "不支持图片输入" not in msg, "像素错误不得误报为能力缺失"

    def test_xai_dimension_error_reports_size_issue(self, client, monkeypatch):
        """xAI 边长下限错误文案(Image dimensions 1x1 are too small)同样归类为尺寸问题。"""
        xai_error = (
            "模型接口返回 HTTP 400: Image dimensions 1x1 are too small. "
            "Both width and height must be at least 8 pixels."
        )
        monkeypatch.setattr(client, "_chat", make_error_chat(xai_error))
        ok, msg = asyncio.run(client.test_image_input())
        assert ok is False
        assert "尺寸过小" in msg

    def test_genuine_unsupported_image_still_classified(self, client, monkeypatch):
        """真正的'不支持图片输入'错误分类保持不变(OpenAI 系回归)。"""
        unsupported = "模型接口返回 HTTP 400: This model does not support image input"
        monkeypatch.setattr(client, "_chat", make_error_chat(unsupported))
        ok, msg = asyncio.run(client.test_image_input())
        assert ok is False
        assert "不支持图片输入" in msg

    def test_404_still_classified_as_base_url_issue(self, client, monkeypatch):
        """404 错误分类保持不变。"""
        monkeypatch.setattr(client, "_chat", make_error_chat("模型接口返回 HTTP 404: Not Found"))
        ok, msg = asyncio.run(client.test_image_input())
        assert ok is False
        assert "Base URL" in msg


class TestConfigValidation:
    """配置项校验。"""

    def test_default_is_32(self):
        """默认值 32(1024 像素),满足 xAI 下限。"""
        assert settings.model_test_image_size == 32
        assert settings.model_test_image_size**2 >= 512
