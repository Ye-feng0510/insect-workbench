"""Authoritative taxonomy lookup through the fixed GBIF species-match API."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import httpx

GBIF_MATCH_URL = "https://api.gbif.org/v1/species/match"
GBIF_DATASET_LABEL = "GBIF Backbone Taxonomy"
PROVIDER_POLICY_VERSION = "gbif-match-v1"
MAX_RESPONSE_BYTES = 1_000_000


class TaxonomyResolverError(Exception):
    """The authority provider could not return a safe, usable response."""


def _text(value: Any, limit: int = 500) -> str:
    if not isinstance(value, (str, int, float)):
        return ""
    return str(value).replace("\x00", "").strip()[:limit]


async def resolve_scientific_name(scientific_name: str) -> dict[str, Any] | None:
    """Resolve an exact supplied name against GBIF, without accepting a URL."""
    query = scientific_name.strip()
    if not query:
        return None
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(10.0, connect=5.0),
            follow_redirects=False,
        ) as client:
            response = await client.get(
                GBIF_MATCH_URL,
                params={"name": query, "kingdom": "Animalia", "verbose": "true"},
                headers={"Accept": "application/json"},
            )
    except httpx.TransportError as exc:
        raise TaxonomyResolverError(f"GBIF unavailable: {exc}") from exc

    if response.status_code != 200:
        raise TaxonomyResolverError(f"GBIF returned HTTP {response.status_code}")
    declared_size = response.headers.get("content-length")
    if declared_size and declared_size.isdigit() and int(declared_size) > MAX_RESPONSE_BYTES:
        raise TaxonomyResolverError("GBIF response exceeded size limit")
    if len(response.content) > MAX_RESPONSE_BYTES:
        raise TaxonomyResolverError("GBIF response exceeded size limit")
    try:
        data = response.json()
    except ValueError as exc:
        raise TaxonomyResolverError("GBIF returned invalid JSON") from exc
    if not isinstance(data, dict):
        raise TaxonomyResolverError("GBIF returned an invalid response object")

    usage_key = data.get("usageKey")
    if not isinstance(usage_key, int) or usage_key <= 0:
        return None
    match_type = _text(data.get("matchType"), 50)
    if match_type.upper() == "NONE":
        return None

    lineage = {
        key: _text(data.get(key), 300)
        for key in (
            "kingdom",
            "phylum",
            "class",
            "order",
            "family",
            "genus",
            "species",
        )
    }
    alternatives = []
    raw_alternatives = data.get("alternatives", [])
    if isinstance(raw_alternatives, list):
        for alternative in raw_alternatives[:10]:
            if not isinstance(alternative, dict):
                continue
            alternatives.append(
                {
                    key: _text(alternative.get(key), 300)
                    for key in (
                        "usageKey",
                        "scientificName",
                        "canonicalName",
                        "rank",
                        "status",
                        "confidence",
                        "matchType",
                    )
                }
            )
    return {
        "query": query[:300],
        "usage_key": usage_key,
        "scientific_name": _text(data.get("scientificName"), 500),
        "canonical_name": _text(data.get("canonicalName"), 300),
        "authorship": _text(data.get("authorship"), 300),
        "rank": _text(data.get("rank"), 50),
        "status": _text(data.get("status"), 50),
        "confidence": data.get("confidence")
        if isinstance(data.get("confidence"), (int, float))
        else None,
        "match_type": match_type,
        "lineage": lineage,
        "alternatives": alternatives,
        "provenance": {
            "provider": "GBIF",
            "dataset": GBIF_DATASET_LABEL,
            "policy_version": PROVIDER_POLICY_VERSION,
            "retrieved_at": datetime.now(timezone.utc).isoformat(),
            "source_url": f"https://www.gbif.org/species/{usage_key}",
            "usage_key": usage_key,
        },
    }
