"""FastAPI 应用入口。开发时前后端分离(CORS),生产时 mount 前端 dist。"""
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.config import FRONTEND_DIST, settings
from app.database import init_db
from app.routers import settings as settings_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    """启动时初始化数据库与目录。"""
    init_db()
    yield


app = FastAPI(
    title=settings.app_name,
    lifespan=lifespan,
)

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
    """健康检查接口,用于前后端连通测试。"""
    return {"status": "ok", "app": settings.app_name}


# 注册路由
app.include_router(settings_router.router)


# 生产模式: 若前端已构建,则由 FastAPI 托管静态文件
if FRONTEND_DIST.exists():
    app.mount(
        "/",
        StaticFiles(directory=FRONTEND_DIST, html=True),
        name="frontend",
    )
