"""应用配置。所有可配置项通过环境变量传入,不硬编码。"""
from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


# 项目根目录(backend/ 的父目录)
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
DATA_DIR = PROJECT_ROOT / "data"
TEMPLATES_DIR = DATA_DIR / "templates"
IMAGES_DIR = DATA_DIR / "images"
PROCESSED_IMAGES_DIR = DATA_DIR / "processed_images"
EXPORTS_DIR = DATA_DIR / "exports"
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

    # 图片预处理(清单第9节)
    image_max_long_edge: int = 3000
    image_jpeg_quality: int = 90

    # 开发模式: 前端独立运行时允许跨域
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]


settings = Settings()


def ensure_dirs() -> None:
    """首次启动时自动创建数据目录。"""
    for d in (TEMPLATES_DIR, IMAGES_DIR, PROCESSED_IMAGES_DIR, EXPORTS_DIR, DATA_DIR):
        d.mkdir(parents=True, exist_ok=True)
