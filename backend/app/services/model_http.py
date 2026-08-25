"""进程级共享 httpx 连接池。

此前每次模型请求都新建 AsyncClient,包含 TCP+TLS 握手开销(1~2s/次)。
本模块提供进程生命周期内复用的连接池:
- get_http_client(): 惰性创建单例,任何协程可直接复用(线程安全由事件循环保证)。
- close_http_client(): 应用关闭时释放,挂在 lifespan。
- Authorization 等凭据仍按请求头传入,多供应商并存互不影响。
- 每次请求可覆写 timeout,前台/后台超时策略互不干扰。
"""
from __future__ import annotations

import httpx

from app.config import settings

_client: httpx.AsyncClient | None = None


def get_http_client() -> httpx.AsyncClient:
    """获取进程级共享 AsyncClient(惰性创建)。"""
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(
            limits=httpx.Limits(
                max_connections=settings.model_http_max_connections,
                max_keepalive_connections=settings.model_http_max_keepalive_connections,
            ),
        )
    return _client


async def close_http_client() -> None:
    """应用关闭时释放连接池。"""
    global _client
    if _client is not None and not _client.is_closed:
        await _client.aclose()
    _client = None


def reset_http_client_for_tests() -> None:
    """测试隔离:丢弃当前单例(不关闭,由测试自行管理)。"""
    global _client
    _client = None
