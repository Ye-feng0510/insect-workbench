"""推理模型(reasoning model)协议兼容测试。

覆盖 DeepSeek R 系等"先思考后作答"模型:思考(reasoning_content)与正式回答
(content)共享 max_tokens 预算,预算耗尽时 finish_reason="length" 且 content 为空。
_chat() 应基于协议字段自适应放大预算重试,而非直接报"模型返回空内容"。
"""
import asyncio
import json

import httpx
import pytest

from app.config import settings
from app.services.model_provider import ModelError, VisionModelClient


@pytest.fixture(autouse=True)
def _reset_shared_http_pool():
    """共享连接池单例按测试隔离:每个用例前后都丢弃当前实例。"""
    from app.services import model_http

    model_http.reset_http_client_for_tests()
    yield
    model_http.reset_http_client_for_tests()


class FakeResponse:
    def __init__(self, payload: dict, status_code: int = 200):
        self._payload = payload
        self.status_code = status_code
        self.text = json.dumps(payload)

    def json(self) -> dict:
        return self._payload


def make_response(
    content: str = "",
    reasoning: str = "思考中...",
    finish_reason: str = "length",
):
    """构造 OpenAI 兼容 chat completion 响应(已包装为 FakeResponse)。"""
    message = {"role": "assistant", "content": content}
    if reasoning is not None:
        message["reasoning_content"] = reasoning
    return FakeResponse({
        "choices": [
            {"index": 0, "message": message, "finish_reason": finish_reason}
        ],
        "usage": {"prompt_tokens": 100, "completion_tokens": 50},
    })


class FakeAsyncClient:
    """按预设序列返回响应,并捕获每次请求的 payload。"""

    def __init__(self, responses: list, captured: list, timeout=None, limits=None):
        self._responses = responses
        self._captured = captured
        self.is_closed = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def post(self, url, json=None, headers=None, timeout=None):
        # 深拷贝快照:_chat 会原地放大 payload["max_tokens"],
        # 引用同一 dict 会让所有快照显示最终值
        self._captured.append({"url": url, "json": dict(json), "headers": headers})
        item = self._responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


@pytest.fixture
def client():
    return VisionModelClient(
        "https://api.example.com/v1", "sk-test", "deepseek-v4-flash-vision-exp", timeout=5
    )


def run_chat(c, messages=None, **kwargs):
    messages = messages or [{"role": "user", "content": "hi"}]
    return asyncio.run(c._chat(messages, **kwargs))


class TestNonReasoningRegression:
    """非推理模型(默认路径)行为回归:与旧实现字节级等价。"""

    def test_plain_content_returned_as_is(self, client, monkeypatch):
        """无 reasoning_content、正常 content -> 原样返回,单次请求。"""
        captured = []
        responses = [
            make_response(content='{"主色调":"红色"}', reasoning=None, finish_reason="stop"),
        ]
        monkeypatch.setattr(
            httpx, "AsyncClient",
            lambda timeout=None, limits=None: FakeAsyncClient(responses, captured),
        )
        assert run_chat(client) == '{"主色调":"红色"}'
        assert len(captured) == 1
        assert captured[0]["json"]["max_tokens"] == 2000  # 默认参数不变

    def test_network_retries_unchanged(self, client, monkeypatch):
        """超时仍按 model_max_retries 重试,报错文案不变。"""
        captured = []
        responses = [httpx.ConnectError("boom")] * 3
        monkeypatch.setattr(
            httpx, "AsyncClient",
            lambda timeout=None, limits=None: FakeAsyncClient(responses, captured),
        )
        with pytest.raises(ModelError, match="模型连接失败\\(重试3次后\\)"):
            run_chat(client)
        assert len(captured) == 3


class TestReasoningBudgetEscalation:
    """推理模型预算耗尽 -> 自适应放大重试。"""

    def test_escalate_and_succeed(self, client, monkeypatch):
        """第一次预算耗尽 -> 放大后成功;重试请求 max_tokens 确实被放大。"""
        captured = []
        # 注意:响应队列必须在 lambda 外创建,保证多次 AsyncClient() 共享同一队列
        responses = [
            make_response(content=""),  # 预算被思考耗尽
            make_response(content='{"主色调":"红色"}', finish_reason="stop"),
        ]
        monkeypatch.setattr(
            httpx, "AsyncClient",
            lambda timeout=None, limits=None: FakeAsyncClient(responses, captured),
        )
        assert run_chat(client, max_tokens=50) == '{"主色调":"红色"}'
        assert len(captured) == 2
        assert captured[0]["json"]["max_tokens"] == 50
        assert captured[1]["json"]["max_tokens"] == 200  # 50 * 4
        # 除 max_tokens 外,两次请求其余字段一致(不夹带任何非标参数)
        first, second = captured[0]["json"], captured[1]["json"]
        assert {k: v for k, v in first.items() if k != "max_tokens"} == \
               {k: v for k, v in second.items() if k != "max_tokens"}

    def test_escalation_capped_at_max_tokens(self, client, monkeypatch):
        """放大结果钳制到 model_reasoning_max_tokens 上限。"""
        captured = []
        responses = [
            make_response(content=""),  # 7000*4 -> 钳到 8000
            make_response(content="ok", finish_reason="stop"),
        ]
        monkeypatch.setattr(
            httpx, "AsyncClient",
            lambda timeout=None, limits=None: FakeAsyncClient(responses, captured),
        )
        assert run_chat(client, max_tokens=7000) == "ok"
        assert captured[1]["json"]["max_tokens"] == settings.model_reasoning_max_tokens

    def test_exhausted_at_cap_raises_with_diagnostics(self, client, monkeypatch):
        """放大到上限仍空 -> 报错含 finish_reason/推理标记/最终预算。"""
        captured = []
        responses = [make_response(content="")] * 3
        monkeypatch.setattr(
            httpx, "AsyncClient",
            lambda timeout=None, limits=None: FakeAsyncClient(responses, captured),
        )
        with pytest.raises(ModelError) as exc_info:
            run_chat(client, max_tokens=1024)
        msg = str(exc_info.value)
        assert "finish_reason=length" in msg
        assert "含推理输出=True" in msg
        assert f"max_tokens={settings.model_reasoning_max_tokens}" in msg
        # 1024 -> 4096 -> 8000(钳制)共 3 次请求,不超过 max_escalations=2 次放大
        assert len(captured) == 3
        assert [c["json"]["max_tokens"] for c in captured] == [1024, 4096, 8000]

    def test_escalation_does_not_consume_network_retries(self, client, monkeypatch):
        """放大重试后紧跟一次网络错误,网络重试预算不受放大影响。"""
        captured = []
        responses = [
            make_response(content=""),      # 放大重试
            httpx.ConnectError("flaky"),    # 第1次网络失败
            make_response(content="ok", finish_reason="stop"),
        ]
        monkeypatch.setattr(
            httpx, "AsyncClient",
            lambda timeout=None, limits=None: FakeAsyncClient(responses, captured),
        )
        assert run_chat(client, max_tokens=50) == "ok"
        assert len(captured) == 3


class TestEmptyWithoutReasoning:
    """content 空但无推理输出 -> 直接诊断化报错,不重试。"""

    def test_empty_no_reasoning_raises_immediately(self, client, monkeypatch):
        captured = []
        responses = [
            make_response(content="", reasoning=None, finish_reason="stop"),
        ]
        monkeypatch.setattr(
            httpx, "AsyncClient",
            lambda timeout=None, limits=None: FakeAsyncClient(responses, captured),
        )
        with pytest.raises(ModelError) as exc_info:
            run_chat(client)
        assert "finish_reason=stop" in str(exc_info.value)
        assert "含推理输出=False" in str(exc_info.value)
        assert len(captured) == 1, "无推理输出的空内容不得触发任何重试"

    def test_reasoning_but_stopped_not_length_no_retry(self, client, monkeypatch):
        """有推理但 finish_reason 不是 length(如 content_filter)-> 不放大,直接报错。"""
        captured = []
        responses = [make_response(content="", finish_reason="content_filter")]
        monkeypatch.setattr(
            httpx, "AsyncClient",
            lambda timeout=None, limits=None: FakeAsyncClient(responses, captured),
        )
        with pytest.raises(ModelError, match="finish_reason=content_filter"):
            run_chat(client)
        assert len(captured) == 1


class TestTestConnectionClassification:
    """test_image_input() 对预算耗尽错误的分类。"""

    def test_budget_exhaustion_guidance(self, client, monkeypatch):
        """放大到上限仍空 -> 提示调大预算,而非'不支持图片输入'。"""
        async def fake_chat(messages, max_tokens=2000):
            raise ModelError(
                f"模型返回空内容(finish_reason=length,含推理输出=True,"
                f"max_tokens={settings.model_reasoning_max_tokens})"
            )
        monkeypatch.setattr(client, "_chat", fake_chat)
        ok, msg = asyncio.run(client.test_image_input())
        assert ok is False
        assert "token 预算" in msg
        assert "不支持图片输入" not in msg, "预算耗尽不得误报为能力缺失"

    def test_budgets_follow_configuration(self, client, monkeypatch):
        """测试连接使用 model_max_tokens_test 配置。"""
        captured = {}
        async def fake_chat(messages, max_tokens=2000):
            captured["max_tokens"] = max_tokens
            return '{"主色调":"红色"}'
        monkeypatch.setattr(client, "_chat", fake_chat)
        ok, _ = asyncio.run(client.test_image_input())
        assert ok is True
        assert captured["max_tokens"] == settings.model_max_tokens_test
