"""Excel 导出路由。

清单第 8.5 节:
  GET    /api/export/summary
  POST   /api/export/excel
  GET    /api/export/download/{filename}
"""
from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.database import get_db
from app.services import excel_service

router = APIRouter(prefix="/api/export", tags=["export"])


@router.get("/summary")
async def get_summary(db: Session = Depends(get_db)) -> dict[str, Any]:
    """获取导出汇总信息。"""
    return excel_service.get_export_summary(db)


@router.post("/excel")
async def export_excel(db: Session = Depends(get_db)) -> dict[str, Any]:
    """生成导出 Excel 文件。"""
    return excel_service.export_excel(db)


@router.get("/download/{filename}")
async def download_file(filename: str):
    """下载导出文件。"""
    file_path = excel_service.get_export_file_path(filename)
    return FileResponse(
        str(file_path),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename=filename,
    )
