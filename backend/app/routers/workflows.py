"""Additive conversational workflow API."""
from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth import AuthContext, get_auth_context
from app.database import get_db
from app.models import ExcelTemplate, SpecimenRecord, STATUS_COMPLETED
from app.schemas import (
    ResolveTaxonomyRequest,
    WorkflowCommitRequest,
    WorkflowMessageRequest,
)
from app.services import workflow_service as svc

router = APIRouter(prefix="/api/workflows", tags=["workflows"])


@router.get("/active")
async def active_workflow(
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
) -> dict[str, Any] | None:
    workflow = svc.get_active_workflow(db, ctx.owner_id)
    return svc.workflow_to_detail(db, workflow) if workflow else None


@router.get("/{record_id}")
async def get_workflow(
    record_id: int,
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    record = svc.get_owned_record(db, ctx.owner_id, record_id)
    workflow = svc.get_owned_workflow_for_record(
        db, ctx.owner_id, record_id
    )
    if workflow is None:
        workflow = svc.get_or_create_workflow(db, record)
    return svc.workflow_to_detail(db, workflow)


@router.post("/{record_id}/resolve-taxonomy")
async def resolve_taxonomy(
    record_id: int,
    req: ResolveTaxonomyRequest,
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    record = svc.get_owned_record(db, ctx.owner_id, record_id)
    workflow = svc.get_or_create_workflow(db, record)
    return await svc.resolve_taxonomy(
        db, workflow, req.confirmed, req.scientific_name, req.authorship
    )


@router.post("/{record_id}/retry-taxonomy")
async def retry_taxonomy(
    record_id: int,
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    record = svc.get_owned_record(db, ctx.owner_id, record_id)
    workflow = svc.get_or_create_workflow(db, record)
    return await svc.retry_taxonomy(db, workflow)


@router.post("/{record_id}/messages")
async def add_message(
    record_id: int,
    req: WorkflowMessageRequest,
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    record = svc.get_owned_record(db, ctx.owner_id, record_id)
    workflow = svc.get_or_create_workflow(db, record)
    return await svc.add_explanatory_message(db, workflow, req.content)


@router.post("/{record_id}/commit")
async def commit_workflow(
    record_id: int,
    req: WorkflowCommitRequest,
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    record = svc.get_owned_record(db, ctx.owner_id, record_id)
    workflow = svc.get_or_create_workflow(db, record)
    result, verification = svc.commit_workflow(
        db,
        workflow,
        req.expected_revision,
        req.taxonomy,
        req.duplicate_action,
        req.manual_override_reason,
        req.confirmed,
    )
    template = (
        db.query(ExcelTemplate)
        .filter(
            ExcelTemplate.owner_id == ctx.owner_id,
            ExcelTemplate.is_active.is_(True),
        )
        .first()
    )
    excel_row = 0
    if template and template.base_write_row:
        completed_before = (
            db.query(SpecimenRecord)
            .filter(
                SpecimenRecord.status == STATUS_COMPLETED,
                SpecimenRecord.owner_id == ctx.owner_id,
                SpecimenRecord.id <= result.id,
            )
            .count()
        )
        excel_row = template.base_write_row + completed_before - 1
    return {
        "record_id": result.id,
        "status": result.status,
        "fields": svc.recognition_service.record_to_fields(result),
        "excel_row": excel_row,
        "warnings": json.loads(result.warnings_json)
        if result.warnings_json
        else [],
        "verification_level": verification["verification_level"],
        "provenance": verification["provenance"],
        "conflicts": verification["conflicts"],
    }
