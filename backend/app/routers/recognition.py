"""识别路由。

清单第 8.3 节:
  POST   /api/recognition/extract
  POST   /api/recognition/{record_id}/re-extract
  POST   /api/recognition/{record_id}/confirm-extraction

同步 HTTP 流程,不创建 job_id,不轮询。
"""
import json
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy.orm import Session

from app.database import get_db
from app.field_mapping import IMAGE_EXTRACTED_FIELDS
from app.models import SpecimenRecord, STATUS_COMPLETED
from app.schemas import (
    ConfirmExtractionRequest,
    ConfirmExtractionResponse,
    DuplicateConflict,
    ExtractResponse,
)
from app.services import recognition_service as svc

router = APIRouter(prefix="/api/recognition", tags=["recognition"])


@router.post("/extract", response_model=ExtractResponse)
async def extract(
    file: UploadFile = File(...),
    rotation_degrees: int = Form(0),
    db: Session = Depends(get_db),
):
    """上传图片并提取5项图片原始信息。

    清单 8.3 extract:
    - 接收一张图片
    - 保存图片
    - 创建记录
    - 接收旋转角度并生成预处理图片
    - 调用视觉模型提取5项
    - 状态设为 awaiting_confirmation
    """
    # 校验图片格式
    allowed = {".jpg", ".jpeg", ".png", ".webp"}
    filename = file.filename or "upload.jpg"
    ext = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ".jpg"
    if ext not in allowed:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的图片格式 {ext},请上传 JPG/JPEG/PNG/WebP",
        )

    content = await file.read()

    # 保存图片
    stored_name, stored_path = svc.save_uploaded_image(content, filename)

    # 提取5项信息
    record = await svc.extract_image_info(
        db, stored_path, stored_name, rotation_degrees
    )

    draft = svc.parse_extracted_draft(record)
    return ExtractResponse(
        record_id=record.id,
        status=record.status,
        extracted=draft.get("extracted", {}),
        confidence=draft.get("confidence", {}),
        evidence=draft.get("evidence", {}),
        warnings=draft.get("warnings", []),
    )


@router.post("/{record_id}/re-extract", response_model=ExtractResponse)
async def re_extract(
    record_id: int,
    db: Session = Depends(get_db),
):
    """重新识别:使用同一张原图重新调用视觉模型。"""
    record = db.get(SpecimenRecord, record_id)
    if record is None:
        raise HTTPException(status_code=404, detail="记录不存在")

    record = await svc.re_extract_image_info(db, record)
    draft = svc.parse_extracted_draft(record)
    return ExtractResponse(
        record_id=record.id,
        status=record.status,
        extracted=draft.get("extracted", {}),
        confidence=draft.get("confidence", {}),
        evidence=draft.get("evidence", {}),
        warnings=draft.get("warnings", []),
    )


@router.post("/{record_id}/confirm-extraction")
async def confirm_extraction(
    record_id: int,
    req: ConfirmExtractionRequest,
    db: Session = Depends(get_db),
):
    """确认图片信息并自动入表。

    清单 8.3 confirm-extraction 完整流程。
    """
    record = db.get(SpecimenRecord, record_id)
    if record is None:
        raise HTTPException(status_code=404, detail="记录不存在")

    # 检查图像编号是否重复(在 completed 记录中)
    tuxiang = req.confirmed.get("图像", "").strip()
    existing = svc.check_duplicate_tuxiang(db, tuxiang, exclude_id=record.id)

    if existing is not None and req.duplicate_action != "replace":
        # 返回 409,让前端弹窗选择
        raise HTTPException(
            status_code=409,
            detail=json.dumps(
                {
                    "message": "图像编号已存在",
                    "existing_record_id": existing.id,
                    "existing_summary": {
                        "图像": existing.tuxiang,
                        "中名": existing.zhongming,
                    },
                },
                ensure_ascii=False,
            ),
        )

    # 执行确认+分类+入表
    result = await svc.confirm_and_classify(
        db, record, req.confirmed, req.duplicate_action, existing
    )

    # 计算 Excel 行号(base_write_row + zero_based_index)
    from app.models import ExcelTemplate
    import json as _json

    template = (
        db.query(ExcelTemplate)
        .filter(ExcelTemplate.is_active == True)  # noqa: E712
        .first()
    )
    excel_row = None
    if template and template.base_write_row:
        # 按id升序计算已完成记录的索引
        completed_before = (
            db.query(SpecimenRecord)
            .filter(
                SpecimenRecord.status == STATUS_COMPLETED,
                SpecimenRecord.id <= result.id,
            )
            .count()
        )
        excel_row = template.base_write_row + completed_before - 1

    return ConfirmExtractionResponse(
        record_id=result.id,
        status=result.status,
        fields=svc.record_to_fields(result),
        excel_row=excel_row or 0,
        warnings=json.loads(result.warnings_json) if result.warnings_json else [],
    )
