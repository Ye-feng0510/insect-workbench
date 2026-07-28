@echo off
chcp 65001 >nul
setlocal

set PROJECT_ROOT=%~dp0..
cd /d "%PROJECT_ROOT%"

echo ========================================
echo   昆虫标本工作台 启动脚本
echo ========================================

REM 检查前端是否已构建
if not exist "frontend\dist" (
    echo [1/3] 前端未构建,开始构建...
    cd frontend
    call pnpm install
    if errorlevel 1 (
        echo 前端依赖安装失败
        exit /b 1
    )
    call pnpm build
    if errorlevel 1 (
        echo 前端构建失败
        exit /b 1
    )
    cd ..
    echo [1/3] 前端构建完成
) else (
    echo [1/3] 前端已构建,跳过
)

REM 检查后端虚拟环境
if not exist "backend\venv\Scripts\python.exe" (
    echo [2/3] 创建后端虚拟环境...
    cd backend
    python -m venv venv
    venv\Scripts\python.exe -m pip install --upgrade pip
    venv\Scripts\python.exe -m pip install -r requirements.txt
    cd ..
    echo [2/3] 后端环境就绪
) else (
    echo [2/3] 后端环境已存在,跳过
)

REM 启动服务
echo [3/3] 启动服务...
echo.
echo 访问地址: http://127.0.0.1:8000
echo 按 Ctrl+C 停止
echo.

backend\venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --app-dir backend

endlocal
