"""FastAPI 应用入口。开发时前后端分离(CORS),生产时 mount 前端 dist。"""
import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.exc import OperationalError

logger = logging.getLogger(__name__)

from app.config import FRONTEND_DIST, settings
from app.database import SessionLocal, init_db
from app.db_retry import DatabaseUnavailableError, is_locked_error
from app.routers import settings as settings_router
from app.routers import templates as templates_router
from app.routers import recognition as recognition_router
from app.routers import excel_preview as excel_preview_router
from app.routers import records as records_router
from app.routers import export as export_router
from app.routers import materials as materials_router
from app.routers import auth as auth_router
from app.routers import admin as admin_router
from app.routers import workflows as workflows_router
from app.services.prefetch_service import PrefetchWorker
from app.version import APP_CAPABILITIES, APP_PRODUCT, APP_VERSION


@asynccontextmanager
async def lifespan(app: FastAPI):
    """启动时初始化数据库与目录,启动后台预加载 worker。"""
    init_db()
    # 低峰期(启动时)执行 WAL checkpoint,防止 -wal 文件长期膨胀占盘
    _wal_checkpoint()
    # 存储启动维护:清理上传中断遗留的临时 ZIP(不阻塞启动)
    from app.services.material_storage_service import schedule_startup_maintenance

    maintenance = asyncio.create_task(
        asyncio.to_thread(schedule_startup_maintenance)
    )
    worker = PrefetchWorker()
    await worker.start()
    yield
    await worker.stop()
    maintenance.cancel()


def _wal_checkpoint() -> None:
    """启动时合并 WAL 日志(TRUNCATE 模式),回收 -wal 磁盘空间。

    失败仅记录日志:checkpoint 是维护操作,不影响正确性。
    """
    from sqlalchemy import text

    from app.database import engine

    try:
        with engine.connect() as conn:
            conn.execute(text("PRAGMA wal_checkpoint(TRUNCATE)"))
        logger.info("SQLite WAL checkpoint 完成")
    except Exception:
        logger.warning("SQLite WAL checkpoint 失败(不影响启动)", exc_info=True)


app = FastAPI(
    title=settings.app_name,
    version=APP_VERSION,
    lifespan=lifespan,
)


@app.exception_handler(DatabaseUnavailableError)
async def database_unavailable_handler(request: Request, exc: DatabaseUnavailableError):
    """数据库锁等待超时 → 503 + Retry-After,而非未处理 500。"""
    return JSONResponse(
        status_code=503,
        content={"detail": "数据库正忙,请稍后重试"},
        headers={"Retry-After": "2"},
    )


@app.exception_handler(OperationalError)
async def database_locked_handler(request: Request, exc: OperationalError):
    """未被重试层覆盖的 SQLite 锁冲突 → 503,保留结构化日志。"""
    if not is_locked_error(exc):
        raise exc
    return JSONResponse(
        status_code=503,
        content={"detail": "数据库正忙,请稍后重试"},
        headers={"Retry-After": "2"},
    )


class MaterialUploadLimitMiddleware:
    def __init__(self, asgi_app):
        self.app = asgi_app

    async def __call__(self, scope, receive, send):
        if (
            scope["type"] != "http"
            or scope.get("method") != "POST"
            or scope.get("path") != "/api/materials/upload"
        ):
            await self.app(scope, receive, send)
            return

        limit = (settings.material_zip_max_size_mb + 1) * 1024 * 1024
        headers = dict(scope.get("headers", []))
        try:
            content_length = int(headers.get(b"content-length", b"0"))
        except ValueError:
            content_length = 0
        if content_length > limit:
            response = JSONResponse(
                status_code=413,
                content={"detail": "素材上传请求体过大"},
            )
            await response(scope, receive, send)
            return

        received = 0

        async def limited_receive():
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    raise HTTPException(status_code=413, detail="素材上传请求体过大")
            return message

        await self.app(scope, limited_receive, send)


app.add_middleware(MaterialUploadLimitMiddleware)

# 开发模式: 允许 Vite 开发服务器跨域访问
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health() -> dict:
    """健康检查接口,用于前后端连通测试。

    no-store:健康状态不可被任何层缓存(浏览器/代理),
    保证版本握手与 Docker healthcheck 始终看到实时状态。
    """
    return JSONResponse(
        content={
            "status": "ok",
            "product": APP_PRODUCT,
            "app": settings.app_name,
            "version": APP_VERSION,
            "capabilities": list(APP_CAPABILITIES),
        },
        headers={"Cache-Control": "no-store"},
    )


# 注册路由
app.include_router(auth_router.router)
app.include_router(admin_router.router)
app.include_router(settings_router.router)
app.include_router(templates_router.router)
app.include_router(recognition_router.router)
app.include_router(excel_preview_router.router)
app.include_router(records_router.router)
app.include_router(export_router.router)
app.include_router(materials_router.router)
app.include_router(workflows_router.router)


# 生产模式: 托管前端静态资源,其他前端路由回退到 index.html
if FRONTEND_DIST.exists():
    assets_dir = FRONTEND_DIST / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def frontend_app(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not Found")
        root = FRONTEND_DIST.resolve()
        candidate = (FRONTEND_DIST / full_path).resolve()
        try:
            candidate.relative_to(root)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail="Not Found") from exc
        if candidate.is_file():
            # index.html 必须回源校验:确保服务器升级后刷新页面立即拿到新版本,
            # 不被浏览器启发式缓存卡在旧前端(表现为升级后持续"版本不兼容")。
            # hash 资源(/assets/*)文件名带指纹,由 StaticFiles 默认策略缓存即可。
            headers = (
                {"Cache-Control": "no-cache"}
                if candidate.name == "index.html"
                else None
            )
            return FileResponse(str(candidate), headers=headers)
        if Path(full_path).suffix:
            raise HTTPException(status_code=404, detail="Not Found")
        return FileResponse(
            str(FRONTEND_DIST / "index.html"),
            headers={"Cache-Control": "no-cache"},
        )
