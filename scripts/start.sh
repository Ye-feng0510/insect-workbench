#!/usr/bin/env bash
set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

echo "========================================"
echo "  昆虫标本工作台 启动脚本"
echo "========================================"

# 检查前端是否已构建
if [ ! -d "frontend/dist" ]; then
    echo "[1/3] 前端未构建,开始构建..."
    cd frontend
    pnpm install
    pnpm build
    cd ..
    echo "[1/3] 前端构建完成"
else
    echo "[1/3] 前端已构建,跳过"
fi

# 检查后端虚拟环境
if [ ! -f "backend/venv/bin/python" ]; then
    echo "[2/3] 创建后端虚拟环境..."
    cd backend
    python3 -m venv venv
    venv/bin/python -m pip install --upgrade pip
    venv/bin/python -m pip install -r requirements.txt
    cd ..
    echo "[2/3] 后端环境就绪"
else
    echo "[2/3] 后端环境已存在,跳过"
fi

# 启动服务
echo "[3/3] 启动服务..."
echo ""
echo "访问地址: http://127.0.0.1:8000"
echo "按 Ctrl+C 停止"
echo ""

backend/venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --app-dir backend
