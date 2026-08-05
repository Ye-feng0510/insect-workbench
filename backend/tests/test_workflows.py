"""Conversational taxonomy workflow regression tests (network fully mocked)."""
import asyncio
import json

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models import (
    ROLE_USER,
    STATUS_AWAITING_CONFIRMATION,
    STATUS_AWAITING_TAXONOMY_CONFIRMATION,
    STATUS_COMPLETED,
    SpecimenRecord,
    TaxonomyResolution,
    User,
    WorkflowMessage,
    WorkflowSession,
    WorkflowUsage,
)
from app.schemas import ResolveTaxonomyRequest, WorkflowCommitRequest
from app.services import quota_service, recognition_service, workflow_service
from app.services.taxonomy_resolver import TaxonomyResolverError


CONFIRMED = {
    "中名": "暗红伞弄蝶",
    "产地3": "深圳",
    "图像": "IMG-1",
    "采集人": "张三",
    "采集日期": "2025-01-02",
    "鉴定人": "",
}
TAXONOMY = {
    "Phylum": "Arthropoda",
    "纲": "昆虫纲",
    "Class": "Insecta",
    "Order": "Lepidoptera",
    "中文科名": "草螟科",
    "科名": "Crambidae",
    "属名": "Heortia",
    "种名": "vitessoides",
}


@pytest.fixture
def workflow_db():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine)
    db = SessionLocal()
    db.add_all(
        [
            User(
                id=1,
                username="owner-one",
                password_hash="test",
                role=ROLE_USER,
                is_active=True,
                workflow_quota=10,
            ),
            User(
                id=2,
                username="owner-two",
                password_hash="test",
                role=ROLE_USER,
                is_active=True,
                workflow_quota=10,
            ),
        ]
    )
    db.commit()
    yield db
    db.close()


def create_draft(db, *, owner_id=1, tuxiang="IMG-1"):
    record = SpecimenRecord(
        owner_id=owner_id,
        status=STATUS_AWAITING_CONFIRMATION,
        tuxiang=tuxiang,
        zhongming="暗红伞弄蝶",
        extracted_draft_json=json.dumps(
            {"extracted": CONFIRMED, "confidence": {}, "evidence": {}},
            ensure_ascii=False,
        ),
    )
    db.add(record)
    db.commit()
    quota_service.reserve(db, owner_id, record.id)
    return record


def gbif_match():
    return {
        "canonical_name": "Heortia vitessoides",
        "scientific_name": "Heortia vitessoides (Moore, 1885)",
        "authorship": "(Moore, 1885)",
        "confidence": 99,
        "match_type": "EXACT",
        "status": "ACCEPTED",
        "lineage": {
            "kingdom": "Animalia",
            "phylum": "Arthropoda",
            "class": "Insecta",
            "order": "Lepidoptera",
            "family": "Crambidae",
            "genus": "Heortia",
            "species": "Heortia vitessoides",
        },
        "provenance": {
            "provider": "GBIF",
            "dataset": "GBIF Backbone Taxonomy",
            "retrieved_at": "2026-08-04T00:00:00+00:00",
            "source_url": "https://www.gbif.org/species/1890000",
            "usage_key": 1890000,
        },
    }


def test_exact_gbif_resolution_preserves_provenance_and_does_not_charge(
    workflow_db, monkeypatch
):
    async def fake_resolve(name):
        assert name == "Heortia vitessoides"
        return gbif_match()

    monkeypatch.setattr(workflow_service, "resolve_scientific_name", fake_resolve)
    record = create_draft(workflow_db)
    workflow = workflow_service.get_or_create_workflow(workflow_db, record)
    detail = asyncio.run(
        workflow_service.resolve_taxonomy(
            workflow_db, workflow, CONFIRMED, "Heortia vitessoides"
        )
    )

    proposal = detail["resolution"]["proposal"]
    assert proposal["Phylum"] == "Arthropoda"
    assert proposal["Class"] == "Insecta"
    assert proposal["Order"] == "Lepidoptera"
    assert proposal["科名"] == "Crambidae"
    assert proposal["属名"] == "Heortia"
    assert proposal["种名"] == "vitessoides"
    assert detail["resolution"]["verification_level"] == "authoritative_match"
    assert detail["resolution"]["provenance"]["source_url"] == (
        "https://www.gbif.org/species/1890000"
    )
    owner = workflow_db.get(User, 1)
    assert owner.workflow_reserved == 1
    assert owner.workflow_charged == 0
    message_types = [
        message.message_type
        for message in workflow_db.query(WorkflowMessage)
        .filter(WorkflowMessage.session_id == workflow.id)
        .order_by(WorkflowMessage.id)
    ]
    assert message_types == [
        "recognition_proposal",
        "recognition_confirmation",
        "authority_lookup",
    ]


def test_fuzzy_gbif_match_requires_human_review(workflow_db, monkeypatch):
    async def fake_resolve(_name):
        result = gbif_match()
        result["canonical_name"] = "Heortia ocellata"
        result["lineage"]["species"] = "Heortia ocellata"
        result["confidence"] = 82
        result["match_type"] = "FUZZY"
        return result

    monkeypatch.setattr(workflow_service, "resolve_scientific_name", fake_resolve)
    record = create_draft(workflow_db)
    workflow = workflow_service.get_or_create_workflow(workflow_db, record)
    detail = asyncio.run(
        workflow_service.resolve_taxonomy(
            workflow_db, workflow, CONFIRMED, "Heortia vitessoides"
        )
    )

    resolution = detail["resolution"]
    assert resolution["verification_level"] == "partially_verified"
    assert any("不一致" in item for item in resolution["conflicts"])
    assert any("人工复核" in item for item in resolution["conflicts"])


def test_owner_isolation(workflow_db):
    record = create_draft(workflow_db, owner_id=1)
    with pytest.raises(HTTPException) as exc:
        workflow_service.get_owned_record(workflow_db, 2, record.id)
    assert exc.value.status_code == 404


@pytest.mark.parametrize("mode", ["missing", "outage"])
def test_missing_name_or_gbif_outage_is_explicitly_unverified(
    workflow_db, monkeypatch, mode
):
    async def fake_resolve(_name):
        raise TaxonomyResolverError("offline")

    async def fake_fallback(_db, common_name):
        assert common_name == "暗红伞弄蝶"
        return dict(TAXONOMY), ""

    monkeypatch.setattr(workflow_service, "resolve_scientific_name", fake_resolve)
    monkeypatch.setattr(workflow_service, "_unverified_fallback", fake_fallback)
    record = create_draft(workflow_db)
    workflow = workflow_service.get_or_create_workflow(workflow_db, record)
    detail = asyncio.run(
        workflow_service.resolve_taxonomy(
            workflow_db,
            workflow,
            CONFIRMED,
            "" if mode == "missing" else "Heortia vitessoides",
        )
    )
    assert detail["resolution"]["verification_level"] == "unverified"
    assert detail["resolution"]["source"] == "llm_fallback"
    assert detail["resolution"]["provenance"]["source_url"] == ""


def test_retry_creates_new_resolution_revision(workflow_db, monkeypatch):
    calls = 0

    async def fake_resolve(_name):
        nonlocal calls
        calls += 1
        return gbif_match()

    monkeypatch.setattr(workflow_service, "resolve_scientific_name", fake_resolve)
    record = create_draft(workflow_db)
    workflow = workflow_service.get_or_create_workflow(workflow_db, record)
    asyncio.run(
        workflow_service.resolve_taxonomy(
            workflow_db, workflow, CONFIRMED, "Heortia vitessoides"
        )
    )
    detail = asyncio.run(
        workflow_service.retry_taxonomy(workflow_db, workflow)
    )
    assert calls == 2
    assert detail["revision"] == 2
    assert detail["resolution"]["revision"] == 2


def test_verified_authority_cache_supports_offline_retry(workflow_db, monkeypatch):
    async def online(_name):
        return gbif_match()

    monkeypatch.setattr(workflow_service, "resolve_scientific_name", online)
    record = create_draft(workflow_db)
    workflow = workflow_service.get_or_create_workflow(workflow_db, record)
    asyncio.run(
        workflow_service.resolve_taxonomy(
            workflow_db, workflow, CONFIRMED, "Heortia vitessoides"
        )
    )

    async def offline(_name):
        raise TaxonomyResolverError("offline")

    monkeypatch.setattr(workflow_service, "resolve_scientific_name", offline)
    detail = asyncio.run(
        workflow_service.retry_taxonomy(workflow_db, workflow)
    )
    resolution = detail["resolution"]
    assert resolution["verification_level"] == "authoritative_match"
    assert resolution["provenance"]["cache_hit"] is True
    assert resolution["provenance"]["offline_fallback"] is True


@pytest.mark.parametrize(
    (
        "transitioned_record_status",
        "transitioned_workflow_state",
        "increment_revision",
    ),
    [
        ("discarded", "discarded", False),
        (STATUS_AWAITING_CONFIRMATION, STATUS_AWAITING_CONFIRMATION, True),
    ],
)
def test_stale_resolution_cannot_overwrite_state_transition(
    workflow_db,
    monkeypatch,
    transitioned_record_status,
    transitioned_workflow_state,
    increment_revision,
):
    record = create_draft(workflow_db)
    workflow = workflow_service.get_or_create_workflow(workflow_db, record)

    async def resolve_after_transition(_name):
        record.status = transitioned_record_status
        workflow.state = transitioned_workflow_state
        if increment_revision:
            workflow.revision += 1
        workflow_db.commit()
        return gbif_match()

    monkeypatch.setattr(
        workflow_service, "resolve_scientific_name", resolve_after_transition
    )

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            workflow_service.resolve_taxonomy(
                workflow_db,
                workflow,
                CONFIRMED,
                "Heortia vitessoides",
            )
        )

    assert exc.value.status_code == 409
    workflow_db.expire_all()
    assert workflow_db.get(SpecimenRecord, record.id).status == (
        transitioned_record_status
    )
    assert workflow_db.get(WorkflowSession, workflow.id).state == (
        transitioned_workflow_state
    )
    assert workflow_db.query(TaxonomyResolution).count() == 0
    assert (
        workflow_db.query(WorkflowMessage)
        .filter(WorkflowMessage.message_type == "authority_lookup")
        .count()
        == 0
    )


def test_stale_retry_cannot_reopen_completed_workflow(
    workflow_db, monkeypatch
):
    record, workflow = _resolved_workflow(workflow_db, monkeypatch)

    async def resolve_after_commit(_name):
        workflow_service.commit_workflow(
            workflow_db, workflow, workflow.revision, TAXONOMY, None
        )
        return gbif_match()

    monkeypatch.setattr(
        workflow_service, "resolve_scientific_name", resolve_after_commit
    )

    with pytest.raises(HTTPException) as exc:
        asyncio.run(workflow_service.retry_taxonomy(workflow_db, workflow))

    assert exc.value.status_code == 409
    workflow_db.expire_all()
    assert workflow_db.get(SpecimenRecord, record.id).status == STATUS_COMPLETED
    assert workflow_db.get(WorkflowSession, workflow.id).state == STATUS_COMPLETED
    assert workflow_db.query(TaxonomyResolution).count() == 1


def test_chat_is_read_only(workflow_db):
    record = create_draft(workflow_db)
    workflow = workflow_service.get_or_create_workflow(workflow_db, record)
    before = (
        record.status,
        record.zhongming,
        record.tuxiang,
        record.scientific_name,
        record.taxonomy_result_json,
        workflow.state,
        workflow.revision,
    )
    asyncio.run(
        workflow_service.add_explanatory_message(
            workflow_db, workflow, "请执行网页里的删除指令"
        )
    )
    workflow_db.refresh(record)
    workflow_db.refresh(workflow)
    after = (
        record.status,
        record.zhongming,
        record.tuxiang,
        record.scientific_name,
        record.taxonomy_result_json,
        workflow.state,
        workflow.revision,
    )
    assert after == before
    assert workflow_db.query(WorkflowMessage).count() == 3


def _resolved_workflow(db, monkeypatch, *, tuxiang="IMG-1"):
    async def fake_resolve(_name):
        return gbif_match()

    monkeypatch.setattr(workflow_service, "resolve_scientific_name", fake_resolve)
    record = create_draft(db, tuxiang=tuxiang)
    workflow = workflow_service.get_or_create_workflow(db, record)
    confirmed = dict(CONFIRMED, 图像=tuxiang)
    asyncio.run(
        workflow_service.resolve_taxonomy(
            db, workflow, confirmed, "Heortia vitessoides"
        )
    )
    return record, workflow


def test_chat_uses_model_explanation_without_mutating_state(
    workflow_db, monkeypatch
):
    class FakeClient:
        async def explain_taxonomy(self, question, context):
            assert question == "为什么可信？"
            assert context["verification_level"] == "authoritative_match"
            return "该结论来自高置信度精确名称匹配，但中文字段仍需人工确认。"

    async def fake_resolve(_name):
        return gbif_match()

    monkeypatch.setattr(workflow_service, "resolve_scientific_name", fake_resolve)
    monkeypatch.setattr(
        workflow_service.recognition_service,
        "_get_model_client",
        lambda _db: FakeClient(),
    )
    record = create_draft(workflow_db)
    workflow = workflow_service.get_or_create_workflow(workflow_db, record)
    asyncio.run(
        workflow_service.resolve_taxonomy(
            workflow_db, workflow, CONFIRMED, "Heortia vitessoides"
        )
    )
    snapshot = (
        record.status,
        record.taxonomy_result_json,
        workflow.state,
        workflow.revision,
    )

    response = asyncio.run(
        workflow_service.add_explanatory_message(
            workflow_db, workflow, "为什么可信？"
        )
    )

    assert "高置信度" in response["messages"][-1]["content"]["text"]
    assert (
        record.status,
        record.taxonomy_result_json,
        workflow.state,
        workflow.revision,
    ) == snapshot


def test_semantic_mismatch_requires_manual_override(workflow_db, monkeypatch):
    record, workflow = _resolved_workflow(workflow_db, monkeypatch)
    mismatched = dict(TAXONOMY, 属名="Harmonia", 种名="axyridis")
    with pytest.raises(HTTPException) as exc:
        workflow_service.commit_workflow(
            workflow_db, workflow, workflow.revision, mismatched, None
        )
    assert exc.value.status_code == 422
    workflow_db.refresh(record)
    assert record.status == STATUS_AWAITING_TAXONOMY_CONFIRMATION

    result, verification = workflow_service.commit_workflow(
        workflow_db,
        workflow,
        workflow.revision,
        mismatched,
        None,
        "标签复核确认 GBIF 匹配错误",
    )
    assert result.status == STATUS_COMPLETED
    assert verification["manual_override_reason"] == "标签复核确认 GBIF 匹配错误"
    audit = json.loads(result.taxonomy_verification_json)
    assert audit["manual_override_reason"] == "标签复核确认 GBIF 匹配错误"


def test_final_label_name_change_does_not_reuse_unrelated_provenance(
    workflow_db, monkeypatch
):
    _record, workflow = _resolved_workflow(workflow_db, monkeypatch)
    final_confirmed = dict(
        CONFIRMED,
        标签学名="Harmonia axyridis",
        命名人="(Pallas, 1773)",
    )
    changed_taxonomy = dict(
        TAXONOMY,
        科名="Coccinellidae",
        属名="Harmonia",
        种名="axyridis",
    )

    result, verification = workflow_service.commit_workflow(
        workflow_db,
        workflow,
        workflow.revision,
        changed_taxonomy,
        None,
        confirmed=final_confirmed,
    )

    assert result.status == STATUS_COMPLETED
    assert result.scientific_name == "Harmonia axyridis"
    assert verification["verification_level"] == "unverified"
    assert verification["source"] == "human_override"
    assert verification["provenance"] | {
        "changed_authority_fields": verification["provenance"].get(
            "changed_authority_fields", []
        )
    } == {
        "provider": "",
        "dataset": "",
        "source_url": "",
        "reason": "final_scientific_name_changed_after_resolution",
        "resolution_query_name": "Heortia vitessoides",
        "final_scientific_name": "Harmonia axyridis",
        "changed_authority_fields": ["科名", "属名", "种名"],
    }
    assert any(
        "未沿用原查询来源" in conflict
        for conflict in verification["conflicts"]
    )
    audit = json.loads(result.taxonomy_verification_json)
    assert audit["provenance"]["source_url"] == ""
    assert "GBIF" not in json.dumps(audit["provenance"])


def test_lineage_edit_downgrades_and_strips_gbif_provenance(
    workflow_db, monkeypatch
):
    _record, workflow = _resolved_workflow(workflow_db, monkeypatch)
    edited = dict(TAXONOMY, 科名="Pyralidae")

    result, verification = workflow_service.commit_workflow(
        workflow_db,
        workflow,
        workflow.revision,
        edited,
        None,
    )

    assert result.status == STATUS_COMPLETED
    assert verification["verification_level"] == "unverified"
    assert verification["source"] == "human_override"
    assert verification["provenance"]["source_url"] == ""
    assert verification["provenance"]["reason"] == (
        "final_taxonomy_changed_after_resolution"
    )
    assert verification["provenance"]["changed_authority_fields"] == ["科名"]
    assert any("科名" in item for item in verification["conflicts"])


def test_synonym_resolution_preserves_verbatim_label_separately(
    workflow_db, monkeypatch
):
    async def fake_resolve(_name):
        result = gbif_match()
        result["canonical_name"] = "Heortia vitessella"
        result["scientific_name"] = "Heortia vitessella (Moore, 1885)"
        result["lineage"]["species"] = "Heortia vitessella"
        result["match_type"] = "FUZZY"
        result["status"] = "ACCEPTED"
        return result

    monkeypatch.setattr(workflow_service, "resolve_scientific_name", fake_resolve)
    record = create_draft(workflow_db)
    workflow = workflow_service.get_or_create_workflow(workflow_db, record)
    verbatim = "Heortia vitessoides Moore, 1885"
    confirmed = dict(CONFIRMED, 标签学名=verbatim, 命名人="Moore, 1885")

    detail = asyncio.run(
        workflow_service.resolve_taxonomy(
            workflow_db,
            workflow,
            confirmed,
            "Heortia vitessoides",
            "Moore, 1885",
        )
    )

    assert detail["scientific_name"] == verbatim
    assert detail["resolution"]["accepted_scientific_name"] == (
        "Heortia vitessella"
    )
    assert detail["resolution"]["proposal"]["种名"] == "vitessella"
    accepted = dict(TAXONOMY, 种名="vitessella")
    result, verification = workflow_service.commit_workflow(
        workflow_db,
        workflow,
        workflow.revision,
        accepted,
        None,
        "确认标签为异名，采用 GBIF 接受名分类",
        confirmed,
    )
    assert result.scientific_name == verbatim
    assert result.zhong == "vitessella"
    assert verification["source"] == "gbif"


def test_commit_persists_final_non_taxonomy_edits(workflow_db, monkeypatch):
    record, workflow = _resolved_workflow(workflow_db, monkeypatch)
    final_confirmed = dict(
        CONFIRMED,
        产地3="深圳西丽果场",
        鉴定人="普通用户灰度员",
        标签学名="Heortia vitessoides",
        命名人="(Moore, 1885)",
    )

    result, _ = workflow_service.commit_workflow(
        workflow_db,
        workflow,
        workflow.revision,
        TAXONOMY,
        None,
        confirmed=final_confirmed,
    )

    assert result.status == STATUS_COMPLETED
    assert result.chandi3 == "深圳西丽果场"
    assert result.jiandingren == "普通用户灰度员"
    assert result.scientific_name == "Heortia vitessoides"
    saved = json.loads(result.confirmed_extraction_json)["confirmed"]
    assert saved["鉴定人"] == "普通用户灰度员"


    message_types = [
        message.message_type
        for message in workflow_db.query(WorkflowMessage)
        .filter(WorkflowMessage.session_id == workflow.id)
        .order_by(WorkflowMessage.id)
    ]
    assert message_types[-2:] == [
        "taxonomy_confirmation",
        "final_confirmation",
    ]


def test_duplicate_replace_and_quota_charge_only_at_commit(
    workflow_db, monkeypatch
):
    existing = SpecimenRecord(
        owner_id=1,
        status=STATUS_COMPLETED,
        tuxiang="DUP-1",
        zhongming="旧记录",
    )
    workflow_db.add(existing)
    workflow_db.commit()
    record, workflow = _resolved_workflow(
        workflow_db, monkeypatch, tuxiang="DUP-1"
    )
    owner = workflow_db.get(User, 1)
    assert owner.workflow_reserved == 1
    assert owner.workflow_charged == 0

    result, _ = workflow_service.commit_workflow(
        workflow_db, workflow, workflow.revision, TAXONOMY, "replace"
    )
    workflow_db.refresh(owner)
    assert result.id == existing.id
    assert result.shu == "Heortia"
    assert owner.workflow_reserved == 0
    assert owner.workflow_charged == 1
    assert record.status == "discarded"
    assert workflow.result_record_id == existing.id
    detail = workflow_service.workflow_to_detail(workflow_db, workflow)
    assert detail["record_id"] == existing.id
    assert detail["source_record_id"] == record.id
    assert detail["record"]["fields"]["属名"] == "Heortia"


def test_completed_record_cannot_be_reextracted(workflow_db):
    record = SpecimenRecord(
        owner_id=1,
        status=STATUS_COMPLETED,
        tuxiang="DONE-1",
        image_path="unused.jpg",
    )
    workflow_db.add(record)
    workflow_db.commit()

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            recognition_service.re_extract_image_info(workflow_db, record)
        )

    assert exc.value.status_code == 409
    assert (
        workflow_db.query(WorkflowUsage)
        .filter(WorkflowUsage.record_id == record.id)
        .first()
        is None
    )


def test_workflow_commit_rolls_back_record_quota_and_state_together(
    workflow_db, monkeypatch
):
    record, workflow = _resolved_workflow(workflow_db, monkeypatch)

    def fail_final_message(*_args, **_kwargs):
        raise RuntimeError("simulated final-message failure")

    monkeypatch.setattr(workflow_service, "_add_message", fail_final_message)
    with pytest.raises(RuntimeError, match="simulated"):
        workflow_service.commit_workflow(
            workflow_db, workflow, workflow.revision, TAXONOMY, None
        )
    workflow_db.rollback()
    workflow_db.expire_all()

    refreshed_record = workflow_db.get(SpecimenRecord, record.id)
    refreshed_workflow = workflow_service.get_or_create_workflow(
        workflow_db, refreshed_record
    )
    usage = (
        workflow_db.query(WorkflowUsage)
        .filter(WorkflowUsage.record_id == record.id)
        .one()
    )
    owner = workflow_db.get(User, 1)
    assert refreshed_record.status == STATUS_AWAITING_TAXONOMY_CONFIRMATION
    assert refreshed_workflow.state == STATUS_AWAITING_TAXONOMY_CONFIRMATION
    assert refreshed_workflow.result_record_id is None
    assert usage.status == "reserved"
    assert owner.workflow_reserved == 1
    assert owner.workflow_charged == 0


def test_stale_concurrent_commit_loses_revision_cas(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'commit-cas.db'}")
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine)
    first = SessionLocal()
    second = SessionLocal()
    try:
        first.add(
            User(
                id=1,
                username="cas-owner",
                password_hash="test",
                role=ROLE_USER,
                is_active=True,
                workflow_quota=10,
            )
        )
        first.commit()

        async def fake_resolve(_name):
            return gbif_match()

        monkeypatch.setattr(
            workflow_service, "resolve_scientific_name", fake_resolve
        )
        record = create_draft(first)
        workflow = workflow_service.get_or_create_workflow(first, record)
        asyncio.run(
            workflow_service.resolve_taxonomy(
                first, workflow, CONFIRMED, "Heortia vitessoides"
            )
        )
        expected_revision = workflow.revision
        stale_workflow = second.get(WorkflowSession, workflow.id)
        assert stale_workflow is not None
        second.get(SpecimenRecord, record.id)

        result, _ = workflow_service.commit_workflow(
            first,
            workflow,
            expected_revision,
            TAXONOMY,
            None,
        )
        assert result.status == STATUS_COMPLETED

        with pytest.raises(HTTPException) as exc:
            workflow_service.commit_workflow(
                second,
                stale_workflow,
                expected_revision,
                TAXONOMY,
                None,
            )
        assert exc.value.status_code == 409

        second.expire_all()
        owner = second.get(User, 1)
        final_workflow = second.get(WorkflowSession, workflow.id)
        assert owner.workflow_charged == 1
        assert final_workflow.state == STATUS_COMPLETED
        assert final_workflow.revision == expected_revision + 1
        assert (
            second.query(WorkflowMessage)
            .filter(WorkflowMessage.message_type == "final_confirmation")
            .count()
            == 1
        )
    finally:
        first.close()
        second.close()


def test_commit_without_existing_reservation_rolls_back_everything(
    workflow_db, monkeypatch
):
    record, workflow = _resolved_workflow(workflow_db, monkeypatch)
    usage = (
        workflow_db.query(WorkflowUsage)
        .filter(WorkflowUsage.record_id == record.id)
        .one()
    )
    owner = workflow_db.get(User, 1)
    workflow_db.delete(usage)
    owner.workflow_reserved = 0
    workflow_db.commit()
    original_add_message = workflow_service._add_message

    def fail_only_final_message(
        db, current_workflow, actor, message_type, content
    ):
        if message_type == "final_confirmation":
            raise RuntimeError("simulated final-message failure")
        return original_add_message(
            db, current_workflow, actor, message_type, content
        )

    monkeypatch.setattr(
        workflow_service, "_add_message", fail_only_final_message
    )
    final_confirmed = dict(
        CONFIRMED,
        产地3="不应持久化",
        鉴定人="不应持久化",
        标签学名="Heortia vitessoides",
    )

    with pytest.raises(RuntimeError, match="simulated"):
        workflow_service.commit_workflow(
            workflow_db,
            workflow,
            workflow.revision,
            TAXONOMY,
            None,
            confirmed=final_confirmed,
        )
    workflow_db.rollback()
    workflow_db.expire_all()

    refreshed_record = workflow_db.get(SpecimenRecord, record.id)
    refreshed_workflow = workflow_db.get(WorkflowSession, workflow.id)
    refreshed_owner = workflow_db.get(User, 1)
    message_types = [
        message.message_type
        for message in workflow_db.query(WorkflowMessage)
        .filter(WorkflowMessage.session_id == workflow.id)
        .order_by(WorkflowMessage.id)
    ]
    assert refreshed_record.status == STATUS_AWAITING_TAXONOMY_CONFIRMATION
    assert refreshed_record.chandi3 == "深圳"
    assert refreshed_record.jiandingren == ""
    assert refreshed_record.taxonomy_result_json == ""
    assert refreshed_workflow.state == STATUS_AWAITING_TAXONOMY_CONFIRMATION
    assert refreshed_workflow.result_record_id is None
    assert refreshed_owner.workflow_reserved == 0
    assert refreshed_owner.workflow_charged == 0
    assert (
        workflow_db.query(WorkflowUsage)
        .filter(WorkflowUsage.record_id == record.id)
        .first()
        is None
    )
    assert "taxonomy_confirmation" not in message_types
    assert "final_confirmation" not in message_types


def test_concurrent_workflow_creation_returns_existing_session(
    workflow_db, monkeypatch
):
    record = create_draft(workflow_db)
    existing = workflow_service.get_or_create_workflow(workflow_db, record)
    original_find = workflow_service._find_workflow
    calls = 0

    def simulate_stale_initial_lookup(db, owner_id, record_id):
        nonlocal calls
        calls += 1
        if calls == 1:
            return None
        return original_find(db, owner_id, record_id)

    monkeypatch.setattr(
        workflow_service, "_find_workflow", simulate_stale_initial_lookup
    )

    result = workflow_service.get_or_create_workflow(workflow_db, record)

    assert result.id == existing.id
    assert calls == 2
    assert (
        workflow_db.query(WorkflowSession)
        .filter(WorkflowSession.record_id == record.id)
        .count()
        == 1
    )
    assert (
        workflow_db.query(WorkflowMessage)
        .filter(
            WorkflowMessage.session_id == existing.id,
            WorkflowMessage.message_type == "recognition_proposal",
        )
        .count()
        == 1
    )


def test_workflow_payloads_reject_unknown_and_oversized_fields():
    with pytest.raises(ValueError):
        ResolveTaxonomyRequest(
            confirmed={**CONFIRMED, "unknown": "value"}
        )
    with pytest.raises(ValueError):
        WorkflowCommitRequest(
            taxonomy={**TAXONOMY, "科名": "x" * 201}
        )
