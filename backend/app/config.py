"""应用配置。所有可配置项通过环境变量传入,不硬编码。"""
from pathlib import Path
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


# 项目根目录(backend/ 的父目录)
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
DATA_DIR = PROJECT_ROOT / "data"
TEMPLATES_DIR = DATA_DIR / "templates"
IMAGES_DIR = DATA_DIR / "images"
PROCESSED_IMAGES_DIR = DATA_DIR / "processed_images"
EXPORTS_DIR = DATA_DIR / "exports"
MATERIALS_DIR = DATA_DIR / "materials"
MATERIAL_ZIPS_DIR = MATERIALS_DIR / "zips"
MATERIAL_IMAGES_DIR = MATERIALS_DIR / "images"
MATERIAL_EXPORTS_DIR = MATERIALS_DIR / "skipped_exports"
IMAGE_CACHE_DIR = DATA_DIR / "image_cache"
DB_PATH = DATA_DIR / "app.db"

# 前端构建产物目录
FRONTEND_DIST = PROJECT_ROOT / "frontend" / "dist"


class Settings(BaseSettings):
    """运行时配置。本地单用户应用,默认值即可启动。"""

    model_config = SettingsConfigDict(
        env_file=str(PROJECT_ROOT / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # 服务
    app_name: str = "昆虫标本图片识别与Excel录入工作台"
    backend_host: str = "127.0.0.1"
    backend_port: int = 8000

    # 模型调用内部常量(清单第5.4节:不暴露到设置界面)
    model_timeout_seconds: int = 120
    model_max_retries: int = 2  # 图片提取连续失败上限
    taxonomy_auto_correct_retries: int = 1  # 分类校验失败自动纠正次数

    # 各调用点输出 token 预算(仅是上限,非推理模型消耗不变)。
    # 推理模型(reasoning model)先在 reasoning_content 中思考再输出 content,
    # 两者共享同一 max_tokens 预算,预算过小会导致正式回答被完全挤掉。
    model_max_tokens_test: int = 1024  # 测试连接(图片/文本)
    model_max_tokens_recognize: int = 2000  # 图片识别提取
    model_max_tokens_taxonomy: int = 1200  # 分类补全
    model_max_tokens_explain: int = 1000  # 核验问答

    # 推理模型预算自适应:HTTP 200 但 content 为空 + 含 reasoning_content
    # + finish_reason=="length"(预算被思考耗尽)时,按倍数放大 max_tokens 重试。
    # 判断只依赖 OpenAI 兼容协议标准字段,不区分供应商。
    model_reasoning_budget_multiplier: int = 4  # 每次放大的倍数
    model_reasoning_max_tokens: int = 8000  # 放大上限(成本护栏)
    model_reasoning_max_escalations: int = 2  # 最多放大次数(防无限循环)

    # 模型测试连接图片尺寸(方图边长)。
    # xAI/Grok 官方 API 要求:宽高各>=8 且总像素>=512,否则 400。
    # 默认 32(=1024 像素)同时满足 xAI 下限与最小化初衷;
    # OpenAI 系无下限,行为不变。可用 MODEL_TEST_IMAGE_SIZE 环境变量覆盖。
    model_test_image_size: int = Field(default=32, ge=8)

    # 图片预处理(清单第9节)
    image_max_long_edge: int = 3000
    image_jpeg_quality: int = 90
    # 预处理像素总量上限:超过先降采样再旋转/编码,控制内存峰值(0=不限制)
    image_preprocess_max_pixels: int = 9_000_000

    # 本地 OCR。失败时自动回退到纯视觉模型识别。
    ocr_enabled: bool = True
    ocr_min_confidence: float = 0.45

    # 数据素材 ZIP 安全限制
    material_zip_max_size_mb: int = 2048
    material_zip_max_uncompressed_mb: int = 4096
    material_zip_max_images: int = 20000
    material_zip_max_entries: int = 50000
    material_image_max_pixels: int = 40000000

    # 后台预加载(减少工作台图片切换等待时间)
    material_prefetch_size: int = 30  # ready 低水位(目标保持多少张已就绪)
    material_prefetch_concurrency: int = 3  # 前三张优先并行,之后动态降低并发
    material_prefetch_max_concurrency: int = 3  # 低配置电脑最多并行三张
    material_prefetch_max_lookahead: int = 30  # 最大前瞻排队数(含running/ready/failed)
    material_prefetch_interval: float = 1.0  # worker 轮询间隔(秒)
    material_prefetch_max_retries: int = 3  # 单张素材预加载失败重试次数
    material_prefetch_retry_delay: float = 5.0  # 重试初始延迟(秒)
    # 重启后预加载恢复冷却:避免容器重启瞬间恢复全部任务造成资源峰值
    material_prefetch_recovery_cooldown_seconds: float = 20.0

    # 资源调度:前台(用户手动识别)优先,后台(预加载)动态让渡。
    # 并发能力保留,由优先级与内存压力决定后台实际可用槽位。
    resource_recognition_slots: int = 3  # 识别类任务(前台+后台)全局槽位
    resource_memory_pressure_mb: int = 256  # 系统可用内存低于该值时暂停后台预加载(0=禁用)
    resource_memory_recheck_seconds: float = 5.0  # 内存压力恢复后的重检间隔

    # SQLite 稳定性
    sqlite_journal_mode: str = "wal"  # wal|delete|truncate... 默认 wal 提升读写并发
    sqlite_busy_timeout_ms: int = 15000
    sqlite_lock_retry_delays_ms: tuple[int, ...] = (50, 150, 400)  # 锁冲突退避序列

    # 会话心跳写入节流:同一会话 last_seen_at 至少间隔该秒数才写库(0=每次写)
    auth_session_last_seen_interval_seconds: int = 60

    # 素材存储生命周期
    material_storage_min_free_gb: float = 5.0  # 预计上传后低于该值拒绝上传
    material_storage_warn_free_gb: float = 10.0  # 低于该值仅告警
    material_storage_cleanup_incoming_max_age_hours: int = 24  # 残留 incoming_*.zip 清理阈值
    material_archive_retention_days: int = 7  # 非活跃批次 ZIP/文件保留天数,0=替换后立即清理

    # 开发模式: 前端独立运行时允许跨域
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]

    # 认证。首次启动必须通过环境变量提供管理员凭据。
    auth_cookie_name: str = "insect_session"
    auth_csrf_cookie_name: str = "insect_csrf"
    auth_session_hours: int = 24
    auth_login_max_failures: int = 5
    auth_login_window_seconds: int = 300
    auth_cookie_secure: bool = False
    bootstrap_admin_username: str = Field(
        default="", validation_alias="INSECT_BOOTSTRAP_ADMIN_USERNAME"
    )
    bootstrap_admin_password: str = Field(
        default="", validation_alias="INSECT_BOOTSTRAP_ADMIN_PASSWORD"
    )
    default_user_quota: int = 100


settings = Settings()


def ensure_dirs() -> None:
    """首次启动时自动创建数据目录。"""
    for d in (
        TEMPLATES_DIR,
        IMAGES_DIR,
        PROCESSED_IMAGES_DIR,
        EXPORTS_DIR,
        MATERIAL_ZIPS_DIR,
        MATERIAL_IMAGES_DIR,
        MATERIAL_EXPORTS_DIR,
        IMAGE_CACHE_DIR,
        DATA_DIR,
    ):
        d.mkdir(parents=True, exist_ok=True)
