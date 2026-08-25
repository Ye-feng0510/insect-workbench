"""Pydantic schemas 用于 API 请求和响应校验。"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field, field_validator


WORKFLOW_CONFIRMED_FIELDS = frozenset(
    {
        "中名",
        "产地3",
        "图像",
        "采集人",
        "采集日期",
        "鉴定人",
        "标签学名",
        "命名人",
    }
)
WORKFLOW_TAXONOMY_FIELDS = frozenset(
    {
        "Phylum",
        "纲",
        "Class",
        "Order",
        "中文科名",
        "科名",
        "属名",
        "种名",
        "亚科",
        "族",
        "亚属",
        "Subfamily",
        "Tribe",
        "Subgenus",
    }
)


def _validate_workflow_fields(
    values: dict[str, str],
    *,
    allowed: frozenset[str],
    max_length: int,
    long_fields: frozenset[str] = frozenset(),
) -> dict[str, str]:
    unknown = set(values) - allowed
    if unknown:
        raise ValueError(f"包含不支持的字段: {', '.join(sorted(unknown))}")
    for key, value in values.items():
        limit = 300 if key in long_fields else max_length
        if len(value) > limit:
            raise ValueError(f"字段 {key} 最长为 {limit} 个字符")
    return values


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=1, max_length=500)


class UserInfo(BaseModel):
    id: int
    username: str
    role: str
    is_active: bool
    workflow_quota: int | None
    workflow_reserved: int
    workflow_charged: int

    model_config = {"from_attributes": True}


class LoginResponse(BaseModel):
    user: UserInfo
    csrf_token: str


class UserCreate(BaseModel):
    username: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=12, max_length=500)
    role: str = "user"
    workflow_quota: int | None = Field(default=None, ge=0)


class UserUpdate(BaseModel):
    is_active: bool | None = None
    password: str | None = Field(default=None, min_length=12, max_length=500)


class QuotaUpdate(BaseModel):
    workflow_quota: int | None = Field(default=None, ge=0)
    reason: str = Field(default="", max_length=500)


class AdminDataResetRequest(BaseModel):
    records: bool = True
    materials: bool = True
    workflows: bool = True
    taxonomy: bool = True
    exports: bool = False
    confirmation_username: str = Field(min_length=1, max_length=100)


class AdminUserDeleteRequest(BaseModel):
    confirmation_username: str = Field(min_length=1, max_length=100)
    confirmation_phrase: str = Field(min_length=1, max_length=20)


# ============================================================
# 设置
# ============================================================

class ModelConfig(BaseModel):
    """模型 API 配置(清单第 5.4 节:只允许这三项)。"""
    base_url: str = ""
    api_key: str = ""
    model_name: str = ""


class PromptConfig(BaseModel):
    """提示词配置。"""
    recognition_prompt: str = ""
    taxonomy_prompt: str = ""


class TestModelRequest(BaseModel):
    """测试连接请求(可选传入配置,不传则用已保存配置)。"""
    base_url: str | None = None
    api_key: str | None = None
    model_name: str | None = None


class TestResult(BaseModel):
    """单项测试结果。"""
    passed: bool
    message: str = ""


class TestModelResponse(BaseModel):
    """测试连接响应:必须分别测试图片输入和文本 JSON 分类。"""
    image_test: TestResult
    text_json_test: TestResult
    overall: bool


class ModelsListRequest(BaseModel):
    """获取模型列表请求。"""
    base_url: str
    api_key: str


class ModelsListResponse(BaseModel):
    """获取模型列表响应。"""
    models: list[str]


# ============================================================
# Excel 模板
# ============================================================

class SheetInfo(BaseModel):
    name: str
    rows: int = 0
    cols: int = 0


class FieldMappingUpdate(BaseModel):
    """字段映射配置保存请求。"""
    target_sheet: str
    header_row: int = Field(ge=1)
    start_row: int = Field(ge=1)
    style_source_row: int = Field(ge=1)
    # {"中名": "E", "Phylum": "G", ...}
    field_mapping: dict[str, str]


class TemplateInfo(BaseModel):
    id: int
    original_filename: str
    target_sheet: str
    header_row: int
    start_row: int
    base_write_row: int
    style_source_row: int
    field_mapping: dict[str, str]
    is_active: bool
    created_at: datetime

    model_config = {"from_attributes": True}


# ============================================================
# 识别与记录
# ============================================================

class ExtractResponse(BaseModel):
    """图片提取响应:5 个图片原始信息字段 + 置信度 + 警告。"""
    record_id: int
    status: str
    image_url: str = ""
    extracted: dict[str, str]
    confidence: dict[str, str] = {}
    evidence: dict[str, str] = {}
    warnings: list[str] = []


class ReExtractRequest(BaseModel):
    """重新识别请求，可更新实际模型输入所使用的旋转角度。"""

    rotation_degrees: int | None = Field(default=None, ge=0, lt=360)


class ConfirmExtractionRequest(BaseModel):
    """确认图片信息并自动入表请求。"""
    # 用户最终确认或修改后的 5 个图片信息字段
    confirmed: dict[str, str]
    # 图像编号重复时的处理: None(默认拒绝) | "replace"(覆盖)
    duplicate_action: str | None = None


class ConfirmExtractionResponse(BaseModel):
    """确认入表响应:最终 14 个字段 + 实际 Excel 行号。"""
    record_id: int
    status: str
    fields: dict[str, str]
    excel_row: int
    warnings: list[str] = []


class ResolveTaxonomyRequest(BaseModel):
    confirmed: dict[str, str]
    scientific_name: str = Field(default="", max_length=300)
    authorship: str = Field(default="", max_length=300)

    @field_validator("confirmed")
    @classmethod
    def validate_confirmed(
        cls, values: dict[str, str]
    ) -> dict[str, str]:
        return _validate_workflow_fields(
            values,
            allowed=WORKFLOW_CONFIRMED_FIELDS,
            max_length=200,
            long_fields=frozenset({"标签学名", "命名人"}),
        )


class WorkflowMessageRequest(BaseModel):
    content: str = Field(min_length=1, max_length=4000)


class WorkflowCommitRequest(BaseModel):
    expected_revision: int = Field(ge=0)
    taxonomy: dict[str, str]
    confirmed: dict[str, str] | None = None
    duplicate_action: str | None = Field(default=None, pattern="^replace$")
    manual_override_reason: str = Field(default="", max_length=1000)

    @field_validator("taxonomy")
    @classmethod
    def validate_taxonomy_fields(
        cls, values: dict[str, str]
    ) -> dict[str, str]:
        return _validate_workflow_fields(
            values,
            allowed=WORKFLOW_TAXONOMY_FIELDS,
            max_length=200,
        )

    @field_validator("confirmed")
    @classmethod
    def validate_confirmed_fields(
        cls, values: dict[str, str] | None
    ) -> dict[str, str] | None:
        if values is None:
            return None
        return _validate_workflow_fields(
            values,
            allowed=WORKFLOW_CONFIRMED_FIELDS,
            max_length=200,
            long_fields=frozenset({"标签学名", "命名人"}),
        )


class DuplicateConflict(BaseModel):
    """图像编号重复时的 409 响应。"""
    detail: str = "图像编号已存在"
    existing_record_id: int
    existing_summary: dict[str, str]


class RecordFields(BaseModel):
    """14 个字段的字典表示。"""
    fields: dict[str, str]


class RecordSummary(BaseModel):
    """记录摘要(列表用)。"""
    id: int
    image_filename: str
    status: str
    zhongming: str
    chandi3: str
    tuxiang: str
    caijiren: str
    caiji_riqi: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class RecordDetail(BaseModel):
    """记录详情(含全部 14 字段 + JSON 草稿)。"""
    id: int
    image_filename: str
    image_path: str
    image_url: str = ""
    processed_image_path: str
    rotation_degrees: int
    status: str
    extracted_draft: dict[str, Any]
    confirmed_extraction: dict[str, Any]
    taxonomy_result: dict[str, Any]
    warnings: list[str]
    fields: dict[str, str]
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class RecordUpdate(BaseModel):
    """记录编辑请求。"""
    fields: dict[str, str] | None = None


# ============================================================
# 数据素材图片
# ============================================================

class MaterialBatchInfo(BaseModel):
    id: int
    original_filename: str
    total_count: int
    is_active: bool
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class MaterialItemInfo(BaseModel):
    id: int
    batch_id: int
    sequence: int
    original_filename: str
    archive_path: str
    status: str
    record_id: int | None = None
    error_message: str = ""
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class MaterialSummary(BaseModel):
    batch: MaterialBatchInfo | None = None
    total_count: int = 0
    pending_count: int = 0
    processing_count: int = 0
    completed_count: int = 0
    skipped_count: int = 0
    failed_count: int = 0
    # v1.3.11 标准化进度(门槛提示/轮询恢复)
    preprocess_status: str = "completed"
    preprocessed_count: int = 0
    quota_total: int | None = None
    quota_charged: int = 0
    quota_reserved: int = 0
    quota_remaining: int | None = None
    quota_exhausted: bool = False


class MaterialIngestJobResponse(BaseModel):
    """异步素材摄取任务状态。"""

    job_id: int
    status: str
    # 两阶段进度:extracting(解压) → standardizing(压缩标准化)
    stage: str = "extracting"
    processed_count: int = 0
    total_planned: int = 0
    total_count: int = 0
    error_message: str = ""
    created_at: datetime
    updated_at: datetime


class MaterialExtractResponse(ExtractResponse):
    material_item_id: int
    batch_id: int
    original_filename: str
    pending_count: int


class MaterialPreview(BaseModel):
    item_id: int
    filename: str
    image_url: str


class MaterialPreviewWindow(BaseModel):
    batch_id: int
    items: list[MaterialPreview]


# ============================================================
# Excel 预览与导出
# ============================================================

class PreviewColumn(BaseModel):
    letter: str
    field: str


class PreviewRow(BaseModel):
    excel_row: int
    record_id: int | None = None
    status: str
    values: dict[str, str]


class PreviewResponse(BaseModel):
    sheet_name: str
    mode: str  # "target" | "all"
    header_row: int
    base_write_row: int
    columns: list[PreviewColumn]
    rows: list[PreviewRow]
    completed_count: int
    latest_write_row: int | None = None
    next_write_row: int
    last_updated: datetime


class ExportSummary(BaseModel):
    completed_count: int
    awaiting_confirmation_count: int
    template_name: str
    target_sheet: str
    start_write_row: int


class ExportResult(BaseModel):
    filename: str
    download_url: str
    record_count: int
