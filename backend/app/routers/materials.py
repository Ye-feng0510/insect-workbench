"""数据素材图片路由。"""
from pathlib import Path
import uuid

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, Response
from starlette.concurrency import run_in_threadpool
from sqlalchemy.orm import Session

from app.config import MATERIAL_ZIPS_DIR, settings
from app.auth import AuthContext, get_auth_context
from app.database import get_db
from app.models import (
    MATERIAL_STATUS_COMPLETED,
    MATERIAL_STATUS_FAILED,
    MATERIAL_STATUS_PENDING,
    MATERIAL_STATUS_PROCESSING,
    MATERIAL_STATUS_SKIPPED,
    MaterialItem,
)
from app.schemas import (
    MaterialExtractResponse,
    MaterialItemInfo,
    MaterialPreviewWindow,
    MaterialSummary,
)
from app.services import materials_service
from app.services import material_storage_service
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
async def summary(
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
):
    return materials_service.get_summary(db, ctx.owner_id)


@router.post("/workbench/activate")
async def activate_classic_workbench(
    ctx: AuthContext = Depends(get_auth_context),
):
    from app.services.prefetch_service import activate_owner

    activate_owner(ctx.owner_id)
    return {"status": "active"}


@router.post("/workbench/deactivate")
async def deactivate_classic_workbench(
    ctx: AuthContext = Depends(get_auth_context),
):
    from app.services.prefetch_service import deactivate_owner

    deactivate_owner(ctx.owner_id)
    return {"status": "inactive"}


@router.get("/items", response_model=list[MaterialItemInfo])
async def items(
    status: str | None = Query(None),
    limit: int = Query(200, ge=1, le=settings.material_zip_max_images),
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
):
    if status is not None and status not in VALID_ITEM_STATUSES:
        raise HTTPException(status_code=422, detail="无效的素材状态")
    return materials_service.list_items(
        db, status=status, limit=limit, owner_id=ctx.owner_id
    )


@router.post("/upload", response_model=MaterialSummary)
async def upload_materials(
    file: UploadFile = File(...),
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
):
    filename = file.filename or "materials.zip"
    if Path(filename).suffix.lower() != ".zip":
        raise HTTPException(status_code=400, detail="请上传 ZIP 格式的素材压缩包")
    if recognition_service.get_active_draft(db, ctx.owner_id) is not None:
        raise HTTPException(
            status_code=409,
            detail="工作台存在未完成草稿,请先完成或清空后再上传新的素材包",
        )

    incoming_path = MATERIAL_ZIPS_DIR / f"incoming_{uuid.uuid4().hex}.zip"
    max_bytes = settings.material_zip_max_size_mb * 1024 * 1024
    total = 0
    try:
        # 上传前磁盘预算检查:预计空间不足时立即拒绝,不落盘大文件
        material_storage_service.check_upload_budget(max_bytes)
        with incoming_path.open("wb") as output:
            while chunk := await file.read(1024 * 1024):
                total += len(chunk)
                if total > max_bytes:
                    raise HTTPException(
                        status_code=413,
                        detail=f"压缩包不能超过 {settings.material_zip_max_size_mb} MB",
                    )
                output.write(chunk)
        # ZIP 校验/解压为同步阻塞操作,放入线程池避免阻塞事件循环
        # (健康检查、轮询、其他请求不受大文件解压影响)
        result = await run_in_threadpool(
            materials_service.create_batch_from_zip_path,
            db,
            incoming_path,
            filename,
            ctx.owner_id,
        )
        # 数据库提交成功后,安全清理被替换的旧批次(异步,不影响上传响应)
        import asyncio as _asyncio

        _asyncio.create_task(
            run_in_threadpool(_cleanup_replaced_batches_safely, ctx.owner_id)
        )
        # 通知预加载 worker 立即开始工作
        from app.services.prefetch_service import notify_worker
        notify_worker()
        return result
    except material_storage_service.StorageBudgetError as exc:
        raise HTTPException(status_code=507, detail=str(exc)) from exc
    finally:
        await file.close()
        incoming_path.unlink(missing_ok=True)


def _cleanup_replaced_batches_safely(owner_id: int) -> None:
    """上传成功后清理旧的非活跃批次;失败仅记录日志,不影响主流程。"""
    from app.database import SessionLocal
    from app.services import material_storage_service

    db = SessionLocal()
    try:
        material_storage_service.cleanup_inactive_batches(db, owner_id)
    except Exception:
        # 清理失败不影响已成功的上传;下次上传或维护时会重试
        pass
    finally:
        db.close()


@router.post("/next-extract", response_model=MaterialExtractResponse)
async def next_extract(
    rotation_degrees: int = 0,
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
):
    item, record = await materials_service.start_next_item(
        db,
        rotation_degrees=rotation_degrees,
        owner_id=ctx.owner_id,
    )
    draft = recognition_service.parse_extracted_draft(record)
    summary_data = materials_service.get_summary(db, ctx.owner_id)
    return MaterialExtractResponse(
        material_item_id=item.id,
        batch_id=item.batch_id,
        original_filename=item.original_filename,
        pending_count=summary_data["pending_count"],
        record_id=record.id,
        status=record.status,
        image_url=f"/api/materials/image/{item.id}?variant=preview",
        extracted=draft.get("extracted", {}),
        confidence=draft.get("confidence", {}),
        evidence=draft.get("evidence", {}),
        warnings=draft.get("warnings", []),
    )


@router.post("/{item_id}/skip", response_model=MaterialSummary)
async def skip_item(
    item_id: int,
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
):
    return materials_service.skip_item(db, item_id, ctx.owner_id)


@router.delete("/batch", response_model=MaterialSummary)
async def delete_active_batch(
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
):
    return materials_service.delete_batch(db, ctx.owner_id)


@router.get("/prefetch/status")
async def prefetch_status(
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
):
    """获取当前批次的预加载状态。"""
    return materials_service.get_prefetch_status(db, ctx.owner_id)


@router.get("/next-preview")
async def next_preview(
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
):
    """预览下一张待处理素材（不创建草稿），用于前端先显示图片。"""
    batch = materials_service.get_active_batch(db, ctx.owner_id)
    if batch is None:
        raise HTTPException(status_code=404, detail="尚未上传数据素材压缩包")
    active_draft = recognition_service.get_active_draft(db, ctx.owner_id)
    if active_draft is not None:
        linked = materials_service.get_linked_item(
            db, active_draft.id, ctx.owner_id
        )
        if linked is not None:
            return {
                "item_id": linked.id,
                "filename": linked.original_filename,
                "image_url": f"/api/materials/image/{linked.id}?variant=preview",
            }
    item = (
        db.query(MaterialItem)
        .filter(
            MaterialItem.batch_id == batch.id,
            MaterialItem.status == MATERIAL_STATUS_PENDING,
        )
        .order_by(MaterialItem.sequence.asc())
        .first()
    )
    if item is None:
        raise HTTPException(status_code=404, detail="当前素材包没有待处理图片")
    return {
        "item_id": item.id,
        "filename": item.original_filename,
        "image_url": f"/api/materials/image/{item.id}?variant=preview",
    }


@router.get("/preview-window", response_model=MaterialPreviewWindow)
async def preview_window(
    after_item_id: int | None = Query(None, ge=1),
    limit: int = Query(1, ge=1, le=3),
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
):
    batch = materials_service.get_active_batch(db, ctx.owner_id)
    if batch is None:
        raise HTTPException(status_code=404, detail="尚未上传数据素材压缩包")
    items = materials_service.get_preview_window(
        db,
        ctx.owner_id,
        after_item_id=after_item_id,
        limit=limit,
    )
    return {
        "batch_id": batch.id,
        "items": [
            {
                "item_id": item.id,
                "filename": item.original_filename,
                "image_url": f"/api/materials/image/{item.id}?variant=preview",
            }
            for item in items
        ],
    }


@router.get("/image/{item_id}")
async def material_image(
    item_id: int,
    request: Request,
    variant: str = Query("original", pattern="^(preview|original)$"),
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
):
    from app.models import MaterialBatch

    item = (
        db.query(MaterialItem)
        .join(MaterialBatch, MaterialBatch.id == MaterialItem.batch_id)
        .filter(
            MaterialItem.id == item_id,
            MaterialBatch.owner_id == ctx.owner_id,
        )
        .first()
    )
    if item is None:
        raise HTTPException(status_code=404, detail="素材图片不存在")
    image_path = materials_service.resolve_material_image_path(item.stored_path)
    if not image_path.is_file():
        raise HTTPException(status_code=404, detail="素材图片不存在")
    if variant == "preview":
        from app.services.image_variant_service import get_preview_path

        try:
            image_path = await run_in_threadpool(get_preview_path, image_path)
        except (OSError, ValueError):
            raise HTTPException(status_code=422, detail="素材图片无法生成预览") from None
        # ETag(mtime+size):浏览器缓存命中时条件请求直接 304,
        # 不再重复走 Python 鉴权 + 磁盘全量读取
        stat = image_path.stat()
        etag = f'"{stat.st_mtime_ns:x}-{stat.st_size:x}"'
        if request.headers.get("if-none-match") == etag:
            return Response(status_code=304, headers={
                "ETag": etag,
                "Cache-Control": "private, max-age=86400",
            })
        return FileResponse(
            str(image_path),
            media_type="image/webp",
            headers={
                "Cache-Control": "private, max-age=86400",
                "ETag": etag,
            },
        )
    # 原图与会话绑定且内容不可变(stored_path 随机命名),同会话内允许缓存
    return FileResponse(
        str(image_path),
        filename=item.original_filename,
        headers={"Cache-Control": "private, max-age=86400"},
    )


@router.post("/prefetch/invalidate")
async def prefetch_invalidate(
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
):
    """仅清除当前数据所有者的活跃批次预加载缓存。"""
    from app.models import MaterialPrefetchResult

    batch = materials_service.get_active_batch(db, ctx.owner_id)
    if batch is not None:
        db.query(MaterialPrefetchResult).filter(
            MaterialPrefetchResult.batch_id == batch.id
        ).delete(synchronize_session=False)
        db.commit()
        materials_service._notify_prefetch_worker()
    return {"status": "ok"}


@router.get("/skipped/export")
async def export_skipped(
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
):
    export_path, count = materials_service.create_skipped_export(
        db, ctx.owner_id
    )
    return FileResponse(
        str(export_path),
        media_type="application/zip",
        filename=export_path.name,
        headers={"X-Skipped-Count": str(count)},
    )
