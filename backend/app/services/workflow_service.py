"""Human-confirmed conversational specimen workflow."""
from __future__ import annotations

import json
import re
from typing import Any

from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.field_mapping import FIELD_TO_COLUMN, IMAGE_EXTRACTED_FIELDS
from app.models import (
    ACTIVE_DRAFT_STATUSES,
    STATUS_AWAITING_CONFIRMATION,
    STATUS_AWAITING_TAXONOMY_CONFIRMATION,
    STATUS_COMPLETED,
    MaterialItem,
    SpecimenRecord,
    TaxonConceptCache,
    TaxonomyResolution,
    WorkflowMessage,
    WorkflowSession,
)
from app.services import materials_service, quota_service, recognition_service
from app.services.taxonomy_resolver import (
    PROVIDER_POLICY_VERSION,
    TaxonomyResolverError,
    resolve_scientific_name,
)


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def _load(value: str, default: Any) -> Any:
    if not value:
        return default
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return default


def _add_message(
    db: Session,
    workflow: WorkflowSession,
    actor: str,
    message_type: str,
    content: dict[str, Any],
) -> WorkflowMessage:
    message = WorkflowMessage(
        session_id=workflow.id,
        record_id=workflow.record_id,
        actor=actor,
        message_type=message_type,
        content_json=_json(content),
    )
    db.add(message)
    return message


def get_owned_record(db: Session, owner_id: int, record_id: int) -> SpecimenRecord:
    record = (
        db.query(SpecimenRecord)
        .filter(
            SpecimenRecord.id == record_id,
            SpecimenRecord.owner_id == owner_id,
        )
        .first()
    )
    if record is None:
        raise HTTPException(status_code=404, detail="记录不存在")
    return record


def get_owned_workflow_for_record(
    db: Session, owner_id: int, record_id: int
) -> WorkflowSession | None:
    return (
        db.query(WorkflowSession)
        .filter(
            WorkflowSession.owner_id == owner_id,
            (
                (WorkflowSession.record_id == record_id)
                | (WorkflowSession.result_record_id == record_id)
            ),
        )
        .order_by(WorkflowSession.updated_at.desc(), WorkflowSession.id.desc())
        .first()
    )


def _find_workflow(
    db: Session, owner_id: int, record_id: int
) -> WorkflowSession | None:
    return (
        db.query(WorkflowSession)
        .filter(
            WorkflowSession.record_id == record_id,
            WorkflowSession.owner_id == owner_id,
        )
        .first()
    )


def get_or_create_workflow(
    db: Session, record: SpecimenRecord
) -> WorkflowSession:
    workflow = _find_workflow(db, record.owner_id, record.id)
    if workflow is not None:
        return workflow
    if record.status not in ACTIVE_DRAFT_STATUSES:
        raise HTTPException(
            status_code=409, detail="只有活跃草稿可以创建工作流"
        )
    item = materials_service.get_linked_item(db, record.id, record.owner_id)
    workflow = WorkflowSession(
        owner_id=record.owner_id,
        record_id=record.id,
        material_item_id=item.id if item else None,
        state=record.status,
    )
    try:
        with db.begin_nested():
            db.add(workflow)
            db.flush()
    except IntegrityError:
        db.expire_all()
        concurrent_workflow = _find_workflow(db, record.owner_id, record.id)
        if concurrent_workflow is None:
            raise
        return concurrent_workflow
    draft = recognition_service.parse_extracted_draft(record)
    _add_message(
        db,
        workflow,
        "assistant",
        "recognition_proposal",
        {
            "text": "图像识别草稿已准备，请确认标签字段和学名后查询权威分类。",
            "extracted": draft.get("extracted", {}),
            "confidence": draft.get("confidence", {}),
            "evidence": draft.get("evidence", {}),
        },
    )
    db.commit()
    db.refresh(workflow)
    return workflow


def get_active_workflow(db: Session, owner_id: int) -> WorkflowSession | None:
    record = (
        db.query(SpecimenRecord)
        .filter(
            SpecimenRecord.owner_id == owner_id,
            SpecimenRecord.status.in_(ACTIVE_DRAFT_STATUSES),
        )
        .order_by(SpecimenRecord.id.desc())
        .first()
    )
    return get_or_create_workflow(db, record) if record else None


def _latest_resolution(
    db: Session, workflow: WorkflowSession
) -> TaxonomyResolution | None:
    return (
        db.query(TaxonomyResolution)
        .filter(
            TaxonomyResolution.workflow_id == workflow.id,
            TaxonomyResolution.owner_id == workflow.owner_id,
        )
        .order_by(TaxonomyResolution.revision.desc())
        .first()
    )


def workflow_to_detail(
    db: Session, workflow: WorkflowSession
) -> dict[str, Any]:
    source_record = get_owned_record(
        db, workflow.owner_id, workflow.record_id
    )
    record = (
        get_owned_record(db, workflow.owner_id, workflow.result_record_id)
        if workflow.result_record_id is not None
        else source_record
    )
    messages = (
        db.query(WorkflowMessage)
        .filter(
            WorkflowMessage.session_id == workflow.id,
            WorkflowMessage.record_id == source_record.id,
        )
        .order_by(WorkflowMessage.id.asc())
        .all()
    )
    resolution = (
        _latest_resolution(db, workflow)
        if workflow.state
        in {STATUS_AWAITING_TAXONOMY_CONFIRMATION, STATUS_COMPLETED}
        else None
    )
    resolution_detail = None
    if resolution:
        proposal = _load(resolution.proposal_json, {})
        provenance = _load(resolution.provenance_json, {})
        resolution_detail = {
            "id": resolution.id,
            "revision": resolution.revision,
            "query_name": resolution.query_name,
            "accepted_scientific_name": str(
                provenance.get("accepted_scientific_name") or ""
            ),
            "accepted_scientific_name_authorship": str(
                provenance.get("accepted_scientific_name_authorship") or ""
            ),
            "proposal": proposal,
            "lineage": _load(resolution.lineage_json, {}),
            "provenance": provenance,
            "conflicts": _load(resolution.conflicts_json, []),
            "verification_level": resolution.verification_level,
            "source": resolution.source,
            "created_at": resolution.created_at.isoformat()
            if resolution.created_at
            else None,
        }
    return {
        "id": workflow.id,
        "record_id": record.id,
        "source_record_id": source_record.id,
        "result_record_id": workflow.result_record_id,
        "material_item_id": workflow.material_item_id,
        "state": workflow.state,
        "revision": workflow.revision,
        "record": recognition_service.record_to_detail(record),
        "scientific_name": record.scientific_name,
        "scientific_name_authorship": record.scientific_name_authorship,
        "subfamily": record.subfamily,
        "tribe": record.tribe,
        "subgenus": record.subgenus,
        "resolution": resolution_detail,
        "messages": [
            {
                "id": message.id,
                "actor": message.actor,
                "message_type": message.message_type,
                "content": _load(message.content_json, {}),
                "created_at": message.created_at.isoformat()
                if message.created_at
                else None,
            }
            for message in messages
        ],
        "created_at": workflow.created_at.isoformat()
        if workflow.created_at
        else None,
        "updated_at": workflow.updated_at.isoformat()
        if workflow.updated_at
        else None,
    }


def _proposal_from_gbif(match: dict[str, Any]) -> dict[str, str]:
    lineage = match.get("lineage", {})
    canonical = str(match.get("canonical_name") or lineage.get("species") or "")
    parts = canonical.split()
    epithet = parts[1] if len(parts) >= 2 else ""
    return {
        "Phylum": str(lineage.get("phylum") or ""),
        "纲": "昆虫纲" if lineage.get("class") == "Insecta" else "",
        "Class": str(lineage.get("class") or ""),
        "Order": str(lineage.get("order") or ""),
        "中文科名": "",
        "科名": str(lineage.get("family") or ""),
        "属名": str(lineage.get("genus") or (parts[0] if parts else "")),
        "种名": epithet,
    }


async def _unverified_fallback(
    db: Session, common_name: str
) -> tuple[dict[str, Any], str]:
    try:
        proposal = await recognition_service._call_taxonomy_model(  # noqa: SLF001
            db, common_name
        )
        return proposal, ""
    except HTTPException as exc:
        return {field: "" for field in recognition_service.TAXONOMY_FIELDS}, str(
            exc.detail
        )


def _canonical_binomial(value: str) -> str:
    words = re.findall(r"[A-Za-z][A-Za-z-]*", value)
    if len(words) < 2:
        return ""
    return f"{words[0].capitalize()} {words[1].lower()}"


def _cached_authority_match(
    db: Session, scientific_name: str
) -> dict[str, Any] | None:
    cached = (
        db.query(TaxonConceptCache)
        .filter(
            TaxonConceptCache.provider == "gbif",
            TaxonConceptCache.policy_version == PROVIDER_POLICY_VERSION,
            TaxonConceptCache.query_name == scientific_name.casefold(),
        )
        .first()
    )
    if cached is None:
        return None
    match = _load(cached.match_json, {})
    if not isinstance(match, dict) or not match:
        return None
    provenance = dict(match.get("provenance", {}))
    provenance.update({"cache_hit": True, "offline_fallback": True})
    match["provenance"] = provenance
    return match


def _cache_authority_match(
    db: Session, scientific_name: str, match: dict[str, Any]
) -> None:
    normalized = scientific_name.casefold()
    cached = (
        db.query(TaxonConceptCache)
        .filter(
            TaxonConceptCache.provider == "gbif",
            TaxonConceptCache.policy_version == PROVIDER_POLICY_VERSION,
            TaxonConceptCache.query_name == normalized,
        )
        .first()
    )
    if cached is None:
        cached = TaxonConceptCache(
            provider="gbif",
            policy_version=PROVIDER_POLICY_VERSION,
            query_name=normalized,
        )
        db.add(cached)
    cached.match_json = _json(match)
    db.flush()


async def resolve_taxonomy(
    db: Session,
    workflow: WorkflowSession,
    confirmed: dict[str, str],
    scientific_name: str,
    authorship: str = "",
) -> dict[str, Any]:
    record = get_owned_record(db, workflow.owner_id, workflow.record_id)
    confirmation_type = (
        "taxonomy_retry"
        if workflow.state == STATUS_AWAITING_TAXONOMY_CONFIRMATION
        else "recognition_confirmation"
    )
    if (
        record.status not in ACTIVE_DRAFT_STATUSES
        or workflow.state == STATUS_COMPLETED
    ):
        raise HTTPException(status_code=409, detail="已完成的工作流不能重新解析")
    expected_workflow_state = workflow.state
    expected_record_status = record.status
    expected_revision = workflow.revision
    warnings = recognition_service.validate_confirmed_fields(confirmed)
    normalized_confirmed = {
        str(key): str(value).strip() for key, value in confirmed.items()
    }
    query = scientific_name.strip()[:300]

    match: dict[str, Any] | None = None
    resolver_error = ""
    if query:
        try:
            match = await resolve_scientific_name(query)
        except TaxonomyResolverError as exc:
            resolver_error = str(exc)
        if match is None:
            match = _cached_authority_match(db, query)

    conflicts: list[str] = []
    if match is not None:
        proposal = _proposal_from_gbif(match)
        canonical = str(match.get("canonical_name") or "").strip()
        query_binomial = _canonical_binomial(query)
        match_binomial = _canonical_binomial(canonical)
        if query_binomial and match_binomial and query_binomial != match_binomial:
            conflicts.append(
                f"输入学名 {query_binomial} 与 GBIF 接受名 {match_binomial} 不一致"
            )
        confidence = match.get("confidence")
        match_type = str(match.get("match_type") or "").upper()
        exact_match = bool(
            query_binomial
            and query_binomial == match_binomial
            and match_type == "EXACT"
            and isinstance(confidence, (int, float))
            and confidence >= 95
        )
        if not exact_match:
            conflicts.append(
                "GBIF 未返回高置信度精确双名匹配，必须人工复核候选。"
            )
        provenance = dict(match.get("provenance", {}))
        provenance.update(
            {
                "confidence": confidence,
                "match_type": match_type,
                "status": match.get("status"),
                "alternatives": match.get("alternatives", []),
                "accepted_scientific_name": canonical,
                "accepted_scientific_name_authorship": str(
                    match.get("authorship") or ""
                ),
            }
        )
        lineage = match.get("lineage", {})
        verification_level = (
            "authoritative_match" if exact_match else "partially_verified"
        )
        source = "gbif"
        message_text = (
            "GBIF 权威名称精确匹配已完成；中文分类字段仍需人工确认。"
            if exact_match
            else "GBIF 返回了非精确候选，当前结果必须人工复核后才能提交。"
        )
    else:
        proposal, fallback_error = await _unverified_fallback(
            db, normalized_confirmed["中名"]
        )
        lineage = {}
        provenance = {
            "provider": "configured_model",
            "dataset": "",
            "source_url": "",
            "resolver_error": resolver_error or "GBIF returned no match",
            "fallback_error": fallback_error,
        }
        verification_level = "unverified"
        source = "llm_fallback"
        message_text = (
            "未取得 GBIF 权威匹配；当前分类仅为模型建议，状态为未验证。"
        )
        conflicts.append(provenance["resolver_error"])

    db.refresh(workflow)
    db.refresh(record)
    if (
        workflow.state != expected_workflow_state
        or workflow.revision != expected_revision
        or record.status != expected_record_status
        or workflow.result_record_id is not None
    ):
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail="工作流状态已在分类查询期间变更，已丢弃过期查询结果",
        )

    with db.no_autoflush:
        updated = (
            db.query(WorkflowSession)
            .filter(
                WorkflowSession.id == workflow.id,
                WorkflowSession.owner_id == workflow.owner_id,
                WorkflowSession.state == expected_workflow_state,
                WorkflowSession.revision == expected_revision,
                WorkflowSession.result_record_id.is_(None),
            )
            .update(
                {
                    WorkflowSession.state: (
                        STATUS_AWAITING_TAXONOMY_CONFIRMATION
                    ),
                    WorkflowSession.revision: expected_revision + 1,
                },
                synchronize_session=False,
            )
        )
    if updated != 1:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail="工作流状态已在分类查询期间变更，已丢弃过期查询结果",
        )
    db.refresh(workflow)

    if match is not None and not match.get("provenance", {}).get("cache_hit"):
        _cache_authority_match(db, query, match)
    record.confirmed_extraction_json = _json({"confirmed": normalized_confirmed})
    for field in IMAGE_EXTRACTED_FIELDS:
        if field in normalized_confirmed:
            setattr(
                record,
                FIELD_TO_COLUMN[field],
                normalized_confirmed[field],
            )
    if "鉴定人" in normalized_confirmed:
        record.jiandingren = normalized_confirmed["鉴定人"]
    # `scientific_name` is the verbatim label transcription. The accepted
    # authority name remains separate in the immutable resolution proposal,
    # lineage, and provenance.
    record.scientific_name = (
        normalized_confirmed.get("标签学名", "").strip() or query
    )[:300]
    record.scientific_name_authorship = authorship.strip()[:300]
    _add_message(
        db,
        workflow,
        "user",
        confirmation_type,
        {
            "text": (
                "用户修改上游标签后重新查询分类。"
                if confirmation_type == "taxonomy_retry"
                else "用户已确认标签识别结果并请求查询权威分类。"
            ),
            "confirmed": normalized_confirmed,
            "scientific_name": query,
            "authorship": record.scientific_name_authorship,
        },
    )

    record.status = STATUS_AWAITING_TAXONOMY_CONFIRMATION
    resolution = TaxonomyResolution(
        owner_id=workflow.owner_id,
        workflow_id=workflow.id,
        revision=workflow.revision,
        query_name=query,
        proposal_json=_json(proposal),
        lineage_json=_json(lineage),
        provenance_json=_json(provenance),
        conflicts_json=_json(conflicts),
        verification_level=verification_level,
        source=source,
    )
    db.add(resolution)
    _add_message(
        db,
        workflow,
        "assistant",
        "authority_lookup",
        {
            "text": message_text,
            "verification_level": verification_level,
            "proposal": proposal,
            "provenance": provenance,
        },
    )
    for warning in warnings + conflicts:
        _add_message(
            db,
            workflow,
            "assistant",
            "conflict_warning",
            {"text": warning},
        )
    db.commit()
    return workflow_to_detail(db, workflow)


async def retry_taxonomy(
    db: Session, workflow: WorkflowSession
) -> dict[str, Any]:
    record = get_owned_record(db, workflow.owner_id, workflow.record_id)
    confirmed_wrapper = _load(record.confirmed_extraction_json, {})
    confirmed = confirmed_wrapper.get("confirmed", {})
    if not isinstance(confirmed, dict) or not confirmed:
        raise HTTPException(status_code=409, detail="尚无已确认标签数据")
    return await resolve_taxonomy(
        db,
        workflow,
        {str(k): str(v) for k, v in confirmed.items()},
        record.scientific_name,
        record.scientific_name_authorship,
    )


async def add_explanatory_message(
    db: Session, workflow: WorkflowSession, content: str
) -> dict[str, Any]:
    text = content.strip()
    if not text:
        raise HTTPException(status_code=422, detail="消息不能为空")
    _add_message(
        db, workflow, "user", "question", {"text": text}
    )
    resolution = _latest_resolution(db, workflow)
    if resolution is None:
        fallback_answer = (
            "请先确认标签字段并提交学名查询，我会解释随后产生的候选和证据。"
        )
    elif resolution.verification_level == "unverified":
        fallback_answer = (
            "当前分类是未验证建议，不是权威结论。请核对学名或重试 GBIF 查询，"
            "并在最终提交前逐项确认。"
        )
    else:
        fallback_answer = (
            "当前拉丁分类来自 GBIF 名称匹配；中文科名及更细层级若为空，"
            "表示权威响应未提供，需要人工补充确认。"
        )
    answer = fallback_answer
    if resolution is not None:
        context = {
            "scientific_name": get_owned_record(
                db, workflow.owner_id, workflow.record_id
            ).scientific_name,
            "verification_level": resolution.verification_level,
            "proposal": _load(resolution.proposal_json, {}),
            "lineage": _load(resolution.lineage_json, {}),
            "provenance": _load(resolution.provenance_json, {}),
            "conflicts": _load(resolution.conflicts_json, []),
        }
        try:
            client = recognition_service._get_model_client(db)  # noqa: SLF001
            answer = await client.explain_taxonomy(text, context)
        except Exception:
            answer = fallback_answer
    _add_message(
        db,
        workflow,
        "assistant",
        "explanation",
        {"text": answer, "read_only": True},
    )
    db.commit()
    return workflow_to_detail(db, workflow)


def commit_workflow(
    db: Session,
    workflow: WorkflowSession,
    expected_revision: int,
    taxonomy: dict[str, str],
    duplicate_action: str | None,
    manual_override_reason: str = "",
    confirmed: dict[str, str] | None = None,
) -> tuple[SpecimenRecord, dict[str, Any]]:
    record = get_owned_record(db, workflow.owner_id, workflow.record_id)
    if (
        workflow.state != STATUS_AWAITING_TAXONOMY_CONFIRMATION
        or record.status != STATUS_AWAITING_TAXONOMY_CONFIRMATION
    ):
        raise HTTPException(
            status_code=409, detail="工作流尚未进入分类确认状态"
        )
    resolution = _latest_resolution(db, workflow)
    if resolution is None:
        raise HTTPException(status_code=409, detail="尚无分类解析结果")
    if resolution.revision != expected_revision:
        raise HTTPException(status_code=409, detail="工作流版本已变更，请刷新后重试")
    normalized_taxonomy = {
        str(key): str(value).strip() for key, value in taxonomy.items()
    }
    errors = recognition_service.validate_taxonomy(normalized_taxonomy)
    if errors:
        raise HTTPException(status_code=422, detail=errors)
    stored_confirmed = _load(
        record.confirmed_extraction_json, {}
    ).get("confirmed", {})
    if not isinstance(stored_confirmed, dict):
        raise HTTPException(status_code=409, detail="确认标签数据损坏")
    final_confirmed = {
        str(key): str(value).strip()
        for key, value in (
            confirmed if confirmed is not None else stored_confirmed
        ).items()
    }
    recognition_service.validate_confirmed_fields(final_confirmed)
    final_scientific_name = (
        final_confirmed.get("标签学名", record.scientific_name or "")
    )[:300]
    final_authorship = final_confirmed.get(
        "命名人", record.scientific_name_authorship or ""
    )[:300]
    resolution_query = _canonical_binomial(resolution.query_name)
    final_label_name = _canonical_binomial(final_scientific_name)
    resolution_matches_final_name = bool(
        resolution_query
        and final_label_name
        and resolution_query == final_label_name
    )
    canonical = _canonical_binomial(final_scientific_name)
    taxonomy_binomial = _canonical_binomial(
        f"{normalized_taxonomy.get('属名', '')} "
        f"{normalized_taxonomy.get('种名', '')}"
    )
    override = manual_override_reason.strip()
    if canonical and taxonomy_binomial != canonical and not override:
        raise HTTPException(
            status_code=422,
            detail=(
                f"分类属种 {taxonomy_binomial} 与确认学名 {canonical} 不一致；"
                "如需覆盖必须填写 manual_override_reason"
            ),
        )
    existing = recognition_service.check_duplicate_tuxiang(
        db,
        final_confirmed.get("图像", ""),
        workflow.owner_id,
        exclude_id=record.id,
    )
    if existing is not None and duplicate_action != "replace":
        raise HTTPException(
            status_code=409,
            detail=_json(
                {
                    "message": "图像编号已存在",
                    "existing_record_id": existing.id,
                    "existing_summary": {
                        "图像": existing.tuxiang,
                        "中名": existing.zhongming,
                    },
                }
            ),
        )
    material_item: MaterialItem | None = None
    if workflow.material_item_id:
        material_item = (
            db.query(MaterialItem)
            .filter(MaterialItem.id == workflow.material_item_id)
            .first()
        )
    proposal = _load(resolution.proposal_json, {})
    lineage = _load(resolution.lineage_json, {})
    lineage_species = str(lineage.get("species") or "").split()
    authority_fields = [
        (
            "Phylum",
            normalized_taxonomy.get("Phylum", ""),
            proposal.get("Phylum") or lineage.get("phylum"),
        ),
        ("纲", normalized_taxonomy.get("纲", ""), proposal.get("纲")),
        (
            "Class",
            normalized_taxonomy.get("Class", ""),
            proposal.get("Class") or lineage.get("class"),
        ),
        (
            "Order",
            normalized_taxonomy.get("Order", ""),
            proposal.get("Order") or lineage.get("order"),
        ),
        (
            "科名",
            normalized_taxonomy.get("科名", ""),
            proposal.get("科名") or lineage.get("family"),
        ),
        (
            "属名",
            normalized_taxonomy.get("属名", ""),
            proposal.get("属名") or lineage.get("genus"),
        ),
        (
            "种名",
            normalized_taxonomy.get("种名", ""),
            proposal.get("种名")
            or (lineage_species[1] if len(lineage_species) >= 2 else ""),
        ),
        (
            "亚科",
            normalized_taxonomy.get(
                "Subfamily", normalized_taxonomy.get("亚科", "")
            ),
            lineage.get("subfamily"),
        ),
        (
            "族",
            normalized_taxonomy.get("Tribe", normalized_taxonomy.get("族", "")),
            lineage.get("tribe"),
        ),
        (
            "亚属",
            normalized_taxonomy.get(
                "Subgenus", normalized_taxonomy.get("亚属", "")
            ),
            lineage.get("subgenus"),
        ),
    ]
    changed_authority_fields = [
        field
        for field, submitted_value, authority_value in authority_fields
        if str(authority_value or "").strip()
        and submitted_value.casefold()
        != str(authority_value).strip().casefold()
    ]
    resolution_conflicts = _load(resolution.conflicts_json, [])
    if not isinstance(resolution_conflicts, list):
        resolution_conflicts = []
    if resolution_matches_final_name and not changed_authority_fields:
        verification_level = resolution.verification_level
        verification_source = resolution.source
        verification_provenance = _load(resolution.provenance_json, {})
    else:
        verification_level = "unverified"
        verification_source = "human_override"
        verification_provenance = {
            "provider": "",
            "dataset": "",
            "source_url": "",
            "reason": (
                "final_taxonomy_changed_after_resolution"
                if changed_authority_fields and resolution_matches_final_name
                else "final_scientific_name_changed_after_resolution"
            ),
            "resolution_query_name": resolution.query_name,
            "final_scientific_name": final_scientific_name,
        }
        if changed_authority_fields:
            verification_provenance["changed_authority_fields"] = (
                changed_authority_fields
            )
        if not resolution_matches_final_name:
            resolution_conflicts.append(
                "最终标签学名与本次权威查询名称不一致；未沿用原查询来源，"
                "该提交按未验证人工确认记录。"
            )
        if changed_authority_fields:
            resolution_conflicts.append(
                "最终分类修改了权威候选字段 "
                f"{', '.join(changed_authority_fields)}；未沿用原查询来源，"
                "该提交按未验证人工确认记录。"
            )
    verification = {
        "verification_level": verification_level,
        "source": verification_source,
        "provenance": verification_provenance,
        "conflicts": resolution_conflicts,
        "resolution_revision": resolution.revision,
        "manual_override_reason": override,
    }
    with db.no_autoflush:
        claimed = (
            db.query(WorkflowSession)
            .filter(
                WorkflowSession.id == workflow.id,
                WorkflowSession.owner_id == workflow.owner_id,
                WorkflowSession.state
                == STATUS_AWAITING_TAXONOMY_CONFIRMATION,
                WorkflowSession.revision == expected_revision,
                WorkflowSession.result_record_id.is_(None),
            )
            .update(
                {
                    WorkflowSession.state: STATUS_COMPLETED,
                    WorkflowSession.revision: expected_revision + 1,
                },
                synchronize_session=False,
            )
        )
    if claimed != 1:
        db.rollback()
        raise HTTPException(status_code=409, detail="工作流版本已变更，请刷新后重试")
    record.confirmed_extraction_json = _json({"confirmed": final_confirmed})
    for field in IMAGE_EXTRACTED_FIELDS:
        if field in final_confirmed:
            setattr(record, FIELD_TO_COLUMN[field], final_confirmed[field])
    record.jiandingren = final_confirmed.get("鉴定人", "")[:200]
    record.scientific_name = final_scientific_name
    record.scientific_name_authorship = final_authorship
    _add_message(
        db,
        workflow,
        "user",
        "taxonomy_confirmation",
        {
            "text": "用户已确认最终分类和 Excel 待写入字段。",
            "confirmed": final_confirmed,
            "taxonomy": normalized_taxonomy,
            "manual_override_reason": override,
        },
    )
    record.subfamily = normalized_taxonomy.get(
        "Subfamily", normalized_taxonomy.get("亚科", "")
    )[:200]
    record.tribe = normalized_taxonomy.get(
        "Tribe", normalized_taxonomy.get("族", "")
    )[:200]
    record.subgenus = normalized_taxonomy.get(
        "Subgenus", normalized_taxonomy.get("亚属", "")
    )[:200]
    # Extraction normally owns the reservation; this is an idempotent safety
    # net for drafts migrated from deployments predating quota accounting.
    quota_service.reserve(
        db,
        workflow.owner_id,
        record.id,
        commit_changes=False,
    )
    result = recognition_service.commit_confirmed_taxonomy(
        db,
        record,
        final_confirmed,
        normalized_taxonomy,
        duplicate_action=duplicate_action,
        existing_record=existing,
        material_item=material_item,
        verification=verification,
        billing_record_id=record.id,
        commit_changes=False,
    )
    workflow.state = STATUS_COMPLETED
    workflow.revision = expected_revision + 1
    workflow.result_record_id = result.id
    _add_message(
        db,
        workflow,
        "assistant",
        "final_confirmation",
        {
            "text": "分类已由用户确认并提交。",
            "record_id": result.id,
            "taxonomy": normalized_taxonomy,
            "verification": verification,
        },
    )
    db.commit()
    return result, verification
