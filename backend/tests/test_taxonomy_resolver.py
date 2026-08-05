import asyncio

import httpx
import pytest

from app.services import taxonomy_resolver


def test_remote_protocol_failure_is_normalized(monkeypatch):
    class FailingClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, *_args, **_kwargs):
            raise httpx.RemoteProtocolError("connection closed")

    monkeypatch.setattr(
        taxonomy_resolver.httpx,
        "AsyncClient",
        lambda **_kwargs: FailingClient(),
    )

    with pytest.raises(
        taxonomy_resolver.TaxonomyResolverError,
        match="GBIF unavailable",
    ):
        asyncio.run(
            taxonomy_resolver.resolve_scientific_name(
                "Chrysoperla sinica"
            )
        )
