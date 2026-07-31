"""数据素材图片路由。"""
from pathlib import Path
import uuid

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.config import MATERIAL_ZIPS_DIR, settings
from app.database import get_db
from app.models import (
    MATERIAL_STATUS_COMPLETED,
    MATERIAL_STATUS_FAILED,
    MATERIAL_STATUS_PENDING,
    MATERIAL_STATUS_PROCESSING,
    MATERIAL_STATUS_SKIPPED,
)
from app.schemas import (
    MaterialExtractResponse,
    MaterialItemInfo,
    MaterialSummary,
)
from app.services import materials_service
from app.services import recognition_service


router = APIRouter(prefix="/api/materials", tags=["materials"])
VALID_ITEM_STATUSES = {
    MATERIAL_STATUS_PENDING,
    MATERIAL_STATUS_PROCESSING,
    MATERIAL_STATUS_COMPLETED,
    MATERIAL_STATUS_SKIPPED,
    MATERIAL_STATUS_FAILED,
}


@router.get("/summary", response_model=MaterialSummary)
async def summary(db: Session = Depends(get_db)):
    return materials_service.get_summary(db)


@router.get("/items", response_model=list[MaterialItemInfo])
async def items(
    status: str | None = Query(None),
    limit: int = Query(200, ge=1, le=settings.material_zip_max_images),
    db: Session = Depends(get_db),
):
    if status is not None and status not in VALID_ITEM_STATUSES:
        raise HTTPException(status_code=422, detail="无效的素材状态")
    return materials_service.list_items(db, status=status, limit=limit)


@router.post("/upload", response_model=MaterialSummary)
async def upload_materials(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    filename = file.filename or "materials.zip"
    if Path(filename).suffix.lower() != ".zip":
        raise HTTPException(status_code=400, detail="请上传 ZIP 格式的素材压缩包")
    if recognition_service.get_active_draft(db) is not None:
        raise HTTPException(
            status_code=409,
            detail="工作台存在未完成草稿,请先完成或清空后再上传新的素材包",
        )

    incoming_path = MATERIAL_ZIPS_DIR / f"incoming_{uuid.uuid4().hex}.zip"
    max_bytes = settings.material_zip_max_size_mb * 1024 * 1024
    total = 0
    try:
        with incoming_path.open("wb") as output:
            while chunk := await file.read(1024 * 1024):
                total += len(chunk)
                if total > max_bytes:
                    raise HTTPException(
                        status_code=413,
                        detail=f"压缩包不能超过 {settings.material_zip_max_size_mb} MB",
                    )
                output.write(chunk)
        return materials_service.create_batch_from_zip_path(
            db,
            incoming_path,
            filename,
        )
    finally:
        await file.close()
        incoming_path.unlink(missing_ok=True)


@router.post("/next-extract", response_model=MaterialExtractResponse)
async def next_extract(db: Session = Depends(get_db)):
    item, record = await materials_service.start_next_item(db)
    draft = recognition_service.parse_extracted_draft(record)
    summary_data = materials_service.get_summary(db)
    return MaterialExtractResponse(
        material_item_id=item.id,
        batch_id=item.batch_id,
        original_filename=item.original_filename,
        pending_count=summary_data["pending_count"],
        record_id=record.id,
        status=record.status,
        extracted=draft.get("extracted", {}),
        confidence=draft.get("confidence", {}),
        evidence=draft.get("evidence", {}),
        warnings=draft.get("warnings", []),
    )


@router.post("/{item_id}/skip", response_model=MaterialSummary)
async def skip_item(item_id: int, db: Session = Depends(get_db)):
    return materials_service.skip_item(db, item_id)


@router.delete("/batch", response_model=MaterialSummary)
async def delete_active_batch(db: Session = Depends(get_db)):
    return materials_service.delete_batch(db)


@router.get("/prefetch/status")
async def prefetch_status(db: Session = Depends(get_db)):
    """获取当前批次的预加载状态。"""
    return materials_service.get_prefetch_status(db)


@router.post("/prefetch/invalidate")
async def prefetch_invalidate(db: Session = Depends(get_db)):
    """清除所有预加载缓存(配置变更后调用)。"""
    from app.services.prefetch_service import get_worker
    worker = get_worker()
    if worker is not None:
        worker.clear_all()
    return {"status": "ok"}


@router.get("/skipped/export")
async def export_skipped(db: Session = Depends(get_db)):
    export_path, count = materials_service.create_skipped_export(db)
    return FileResponse(
        str(export_path),
        media_type="application/zip",
        filename=export_path.name,
        headers={"X-Skipped-Count": str(count)},
    )
