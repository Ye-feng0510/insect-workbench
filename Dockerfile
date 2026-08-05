# ===== Stage 1: 构建前端 =====
FROM node:22-slim AS frontend-builder

WORKDIR /build

# 启用 pnpm (Node 22 自带 corepack)
RUN corepack enable pnpm

# 先复制依赖文件,利用 Docker 缓存
COPY frontend/package.json frontend/pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile

# 复制源码并构建
COPY frontend/ ./

RUN pnpm build

# ===== Stage 2: 后端运行时 =====
FROM python:3.12-slim AS runtime

# 项目根目录 = /app
# 目录结构与本地一致:
#   /app/backend/app/    后端代码
#   /app/frontend/dist/  前端构建产物
#   /app/data/           数据目录(SQLite/图片/模板/导出)
WORKDIR /app/backend

RUN apt-get -o Acquire::Retries=3 update \
    && apt-get -o Acquire::Retries=3 install -y --no-install-recommends libgl1 libglib2.0-0 libxcb1 \
    && rm -rf /var/lib/apt/lists/*

# 先复制依赖文件,利用 Docker 缓存
COPY backend/requirements.txt /app/backend/requirements.txt

RUN pip install --no-cache-dir -r requirements.txt

# 复制后端代码
COPY backend/app /app/backend/app

# 从 Stage 1 复制前端构建产物
COPY --from=frontend-builder /build/dist /app/frontend/dist

# 创建数据目录
RUN mkdir -p /app/data/templates /app/data/images /app/data/processed_images /app/data/exports

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health')" || exit 1

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
