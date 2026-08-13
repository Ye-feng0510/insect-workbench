"""管理员用户业务数据概览与清理。"""
from __future__ import annotations

import threading
import shutil
import json
from pathlib import Path
from typing import Iterable
from uuid import uuid4

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.config import DATA_DIR
from app.models import (
    AuthSession,
    ExcelTemplate,
    ExportArtifact,
    MaterialBatch,
    MaterialItem,
    MaterialPrefetchResult,
    SpecimenRecord,
    TaxonomyCache,
    TaxonomyResolution,
    WorkflowMessage,
    WorkflowSession,
    WorkflowUsage,
    User,
    USAGE_CHARGED,
    QuotaAdjustment,
    DeletedAccountAudit,
)
from app.services import prefetch_service

_reset_lock = threading.Lock()


def _path_size(path: Path) -> int:
    try:
        if path.is_file():
            return path.stat().st_size
        if path.is_dir():
            return sum(item.stat().st_size for item in path.rglob("*") if item.is_file())
    except OSError:
        return 0
    return 0


def _unique_paths(paths: Iterable[str | None]) -> list[Path]:
    result: list[Path] = []
    seen: set[str] = set()
    for raw in paths:
        if not raw:
            continue
        path = Path(raw)
        key = str(path.resolve(strict=False))
        if key not in seen:
            seen.add(key)
            result.append(path)
    return result


def get_data_summary(db: Session, user_id: int) -> dict:
    user = db.get(User, user_id)
    if user is None:
        raise ValueError("用户不存在")
    records = db.query(SpecimenRecord).filter(SpecimenRecord.owner_id == user_id).all()
    batches = db.query(MaterialBatch).filter(MaterialBatch.owner_id == user_id).all()
    exports = db.query(ExportArtifact).filter(ExportArtifact.owner_id == user_id).all()
    record_paths = _unique_paths(
        path for record in records for path in (record.image_path, record.processed_image_path)
    )
    material_paths = _unique_paths(
        path for batch in batches for path in (batch.stored_zip_path, batch.extract_dir)
    )
    export_paths = _unique_paths(export.stored_path for export in exports)
    return {
        "user_id": user.id,
        "username": user.username,
        "records": db.query(func.count(SpecimenRecord.id)).filter(
            SpecimenRecord.owner_id == user_id
        ).scalar(),
        "material_batches": len(batches),
        "material_items": db.query(func.count(MaterialItem.id)).join(
            MaterialBatch, MaterialItem.batch_id == MaterialBatch.id
        ).filter(MaterialBatch.owner_id == user_id).scalar(),
        "workflow_sessions": db.query(func.count(WorkflowSession.id)).filter(
            WorkflowSession.owner_id == user_id
        ).scalar(),
        "taxonomy_cache": db.query(func.count(TaxonomyCache.id)).filter(
            TaxonomyCache.owner_id == user_id
        ).scalar(),
        "exports": len(exports),
        "record_bytes": sum(_path_size(path) for path in record_paths),
        "material_bytes": sum(_path_size(path) for path in material_paths),
        "export_bytes": sum(_path_size(path) for path in export_paths),
        "charged_usage": db.query(func.count(WorkflowUsage.id)).filter(
            WorkflowUsage.owner_id == user_id,
            WorkflowUsage.status == USAGE_CHARGED,
        ).scalar(),
    }


def reset_user_data(
    db: Session,
    user_id: int,
    *,
    records: bool,
    materials: bool,
    workflows: bool,
    taxonomy: bool,
    exports: bool,
) -> dict:
    if not any((records, materials, workflows, taxonomy, exports)):
        raise ValueError("至少选择一类业务数据")
    user = db.get(User, user_id)
    if user is None:
        raise ValueError("用户不存在")

    record_rows = (
        db.query(SpecimenRecord).filter(SpecimenRecord.owner_id == user_id).all()
        if records else []
    )
    batch_rows = (
        db.query(MaterialBatch).filter(MaterialBatch.owner_id == user_id).all()
        if materials else []
    )
    export_rows = (
        db.query(ExportArtifact).filter(ExportArtifact.owner_id == user_id).all()
        if exports else []
    )
    paths = _unique_paths(
        path
        for row in record_rows
        for path in (row.image_path, row.processed_image_path)
    )
    paths.extend(
        path
        for path in _unique_paths(
            path for row in batch_rows for path in (row.stored_zip_path, row.extract_dir)
        )
        if str(path.resolve(strict=False)) not in {str(item.resolve(strict=False)) for item in paths}
    )
    paths.extend(
        path
        for path in _unique_paths(row.stored_path for row in export_rows)
        if str(path.resolve(strict=False)) not in {str(item.resolve(strict=False)) for item in paths}
    )

    staged: list[tuple[Path, Path]] = []
    trash_dir = DATA_DIR / ".admin-reset-trash" / uuid4().hex
    with _reset_lock:
        prefetch_service.deactivate_owner(user_id)
        was_active = user.is_active
        user.is_active = False
        db.query(AuthSession).filter(AuthSession.user_id == user_id).delete(
            synchronize_session=False
        )
        try:
            trash_dir.mkdir(parents=True, exist_ok=False)
            for index, path in enumerate(paths):
                if path.exists():
                    target = trash_dir / str(index)
                    shutil.move(str(path), str(target))
                    staged.append((path, target))
            if materials:
                batch_ids = [row.id for row in batch_rows]
                if batch_ids:
                    db.query(MaterialPrefetchResult).filter(
                        MaterialPrefetchResult.batch_id.in_(batch_ids)
                    ).delete(synchronize_session=False)
                    db.query(MaterialItem).filter(MaterialItem.batch_id.in_(batch_ids)).delete(
                        synchronize_session=False
                    )
                    db.query(MaterialBatch).filter(MaterialBatch.id.in_(batch_ids)).delete(
                        synchronize_session=False
                    )
            if workflows or records:
                workflow_ids = [
                    row.id
                    for row in db.query(WorkflowSession).filter(
                        WorkflowSession.owner_id == user_id
                    ).all()
                ]
                if workflow_ids:
                    db.query(TaxonomyResolution).filter(
                        TaxonomyResolution.workflow_id.in_(workflow_ids)
                    ).delete(synchronize_session=False)
                    db.query(WorkflowMessage).filter(
                        WorkflowMessage.session_id.in_(workflow_ids)
                    ).delete(synchronize_session=False)
                    db.query(WorkflowSession).filter(
                        WorkflowSession.id.in_(workflow_ids)
                    ).delete(synchronize_session=False)
            if taxonomy:
                db.query(TaxonomyCache).filter(TaxonomyCache.owner_id == user_id).delete(
                    synchronize_session=False
                )
            if records:
                db.query(WorkflowUsage).filter(
                    WorkflowUsage.owner_id == user_id,
                    WorkflowUsage.status != USAGE_CHARGED,
                ).delete(synchronize_session=False)
                db.query(WorkflowUsage).filter(
                    WorkflowUsage.owner_id == user_id,
                    WorkflowUsage.status == USAGE_CHARGED,
                ).update({WorkflowUsage.record_id: None}, synchronize_session=False)
                db.query(SpecimenRecord).filter(SpecimenRecord.owner_id == user_id).delete(
                    synchronize_session=False
                )
            if exports:
                db.query(ExportArtifact).filter(ExportArtifact.owner_id == user_id).delete(
                    synchronize_session=False
                )
            user.workflow_reserved = 0
            db.commit()
        except Exception:
            db.rollback()
            for original, staged_path in reversed(staged):
                if staged_path.exists():
                    original.parent.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(staged_path), str(original))
            shutil.rmtree(trash_dir, ignore_errors=True)
            raise
        finally:
            user.is_active = was_active
            db.commit()

    failed_paths: list[str] = []
    released_bytes = 0
    for original, staged_path in staged:
        try:
            released_bytes += _path_size(staged_path)
            if staged_path.is_dir():
                shutil.rmtree(staged_path, ignore_errors=False)
            else:
                staged_path.unlink(missing_ok=True)
        except OSError:
            failed_paths.append(str(original))
    shutil.rmtree(trash_dir, ignore_errors=True)
    return {
        "user_id": user_id,
        "released_bytes": released_bytes,
        "failed_paths": failed_paths,
        "summary": get_data_summary(db, user_id),
    }


def delete_user_account(db: Session, user_id: int, actor_user_id: int) -> dict:
    user = db.get(User, user_id)
    actor = db.get(User, actor_user_id)
    if user is None:
        raise ValueError("用户不存在")
    if actor is None or actor.role != "admin":
        raise ValueError("需要管理员权限")
    if user.id == actor.id:
        raise ValueError("不能删除当前管理员")
    if user.role == "admin":
        if db.query(User).filter(User.role == "admin", User.is_active.is_(True)).count() <= 1:
            raise ValueError("不能删除最后一个管理员")
        raise ValueError("暂不支持删除管理员账号")
    username = user.username
    user_id_value = user.id

    record_rows = db.query(SpecimenRecord).filter(SpecimenRecord.owner_id == user_id).all()
    batch_rows = db.query(MaterialBatch).filter(MaterialBatch.owner_id == user_id).all()
    export_rows = db.query(ExportArtifact).filter(ExportArtifact.owner_id == user_id).all()
    paths = _unique_paths(
        path for row in record_rows for path in (row.image_path, row.processed_image_path)
    )
    paths.extend(
        path for path in _unique_paths(
            path for row in batch_rows for path in (row.stored_zip_path, row.extract_dir)
        )
        if str(path.resolve(strict=False)) not in {str(item.resolve(strict=False)) for item in paths}
    )
    paths.extend(
        path for path in _unique_paths(row.stored_path for row in export_rows)
        if str(path.resolve(strict=False)) not in {str(item.resolve(strict=False)) for item in paths}
    )
    adjustments = db.query(QuotaAdjustment).filter(
        (QuotaAdjustment.user_id == user_id) | (QuotaAdjustment.actor_user_id == user_id)
    ).all()
    charged_count = db.query(WorkflowUsage).filter(
        WorkflowUsage.owner_id == user_id,
        WorkflowUsage.status == USAGE_CHARGED,
    ).count()
    charged_usage = db.query(WorkflowUsage).filter(
        WorkflowUsage.owner_id == user_id,
        WorkflowUsage.status == USAGE_CHARGED,
    ).all()
    staged: list[tuple[Path, Path]] = []
    trash_dir = DATA_DIR / ".admin-account-delete-trash" / uuid4().hex
    with _reset_lock:
        prefetch_service.deactivate_owner(user_id)
        try:
            trash_dir.mkdir(parents=True, exist_ok=False)
            for index, path in enumerate(paths):
                if path.exists():
                    target = trash_dir / str(index)
                    shutil.move(str(path), str(target))
                    staged.append((path, target))
            db.add(
                DeletedAccountAudit(
                    username=username,
                    deleted_user_id=user_id_value,
                    deleted_by_user_id=actor.id,
                    charged_usage_count=charged_count,
                    charged_usage_json=json.dumps(
                        [
                            {
                                "record_id": row.record_id,
                                "status": row.status,
                                "reserved_at": str(row.reserved_at),
                                "charged_at": str(row.charged_at),
                            }
                            for row in charged_usage
                        ],
                        ensure_ascii=False,
                    ),
                    quota_adjustments_json=json.dumps(
                        [
                            {
                                "user_id": row.user_id,
                                "actor_user_id": row.actor_user_id,
                                "old_quota": row.old_quota,
                                "new_quota": row.new_quota,
                                "reason": row.reason,
                                "created_at": str(row.created_at),
                            }
                            for row in adjustments
                        ],
                        ensure_ascii=False,
                    ),
                )
            )
            db.query(AuthSession).filter(AuthSession.user_id == user_id).delete(
                synchronize_session=False
            )
            db.query(MaterialPrefetchResult).filter(
                MaterialPrefetchResult.batch_id.in_([row.id for row in batch_rows])
            ).delete(synchronize_session=False) if batch_rows else None
            db.query(MaterialItem).filter(
                MaterialItem.batch_id.in_([row.id for row in batch_rows])
            ).delete(synchronize_session=False) if batch_rows else None
            db.query(MaterialBatch).filter(MaterialBatch.owner_id == user_id).delete(
                synchronize_session=False
            )
            workflow_ids = [
                row.id for row in db.query(WorkflowSession).filter(
                    WorkflowSession.owner_id == user_id
                ).all()
            ]
            if workflow_ids:
                db.query(TaxonomyResolution).filter(
                    TaxonomyResolution.workflow_id.in_(workflow_ids)
                ).delete(synchronize_session=False)
                db.query(WorkflowMessage).filter(
                    WorkflowMessage.session_id.in_(workflow_ids)
                ).delete(synchronize_session=False)
                db.query(WorkflowSession).filter(
                    WorkflowSession.id.in_(workflow_ids)
                ).delete(synchronize_session=False)
            db.query(TaxonomyCache).filter(TaxonomyCache.owner_id == user_id).delete(
                synchronize_session=False
            )
            db.query(SpecimenRecord).filter(SpecimenRecord.owner_id == user_id).delete(
                synchronize_session=False
            )
            db.query(ExcelTemplate).filter(ExcelTemplate.owner_id == user_id).delete(
                synchronize_session=False
            )
            db.query(ExportArtifact).filter(ExportArtifact.owner_id == user_id).delete(
                synchronize_session=False
            )
            db.query(ExportArtifact).filter(
                ExportArtifact.created_by_user_id == user_id
            ).update(
                {ExportArtifact.created_by_user_id: actor.id},
                synchronize_session=False,
            )
            db.query(WorkflowUsage).filter(WorkflowUsage.owner_id == user_id).delete(
                synchronize_session=False
            )
            db.query(QuotaAdjustment).filter(
                (QuotaAdjustment.user_id == user_id)
                | (QuotaAdjustment.actor_user_id == user_id)
            ).delete(synchronize_session=False)
            db.delete(user)
            db.commit()
        except Exception:
            db.rollback()
            for original, staged_path in reversed(staged):
                if staged_path.exists():
                    original.parent.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(staged_path), str(original))
            shutil.rmtree(trash_dir, ignore_errors=True)
            raise
    released_bytes = sum(_path_size(path) for _, path in staged)
    shutil.rmtree(trash_dir, ignore_errors=True)
    return {
        "user_id": user_id_value,
        "username": username,
        "released_bytes": released_bytes,
        "charged_usage_count": charged_count,
    }
