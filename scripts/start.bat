@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

set PROJECT_ROOT=%~dp0..
cd /d "%PROJECT_ROOT%"

echo ========================================
echo   昆虫标本工作台 启动脚本
echo ========================================
echo.

REM 检查端口 8000 是否被占用
netstat -ano | findstr ":8000 " | findstr "LISTENING" >nul 2>&1
if !errorlevel! equ 0 (
    echo [错误] 端口 8000 已被占用,可能已有实例在运行。
    echo.
    echo 请先关闭占用端口的程序,然后重试。
    echo 查看占用进程: netstat -ano ^| findstr ":8000 "
    echo.
    pause
    exit /b 1
)

REM 检查前端是否已构建
if not exist "frontend\dist\index.html" (
    echo [1/3] 前端未构建,开始构建...
    cd frontend

    REM 检查 pnpm 是否可用
    where pnpm >nul 2>&1
    if !errorlevel! neq 0 (
        echo [错误] 未找到 pnpm,请先安装 Node.js 和 pnpm。
        echo   npm install -g pnpm
        echo.
        pause
        exit /b 1
    )

    call pnpm install
    if !errorlevel! neq 0 (
        echo [错误] 前端依赖安装失败
        echo.
        pause
        exit /b 1
    )
    call pnpm build
    if !errorlevel! neq 0 (
        echo [错误] 前端构建失败
        echo.
        pause
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

    REM 检查 python 是否可用
    where python >nul 2>&1
    if !errorlevel! neq 0 (
        echo [错误] 未找到 python,请先安装 Python 3.12+。
        echo   https://www.python.org/downloads/
        echo.
        pause
        exit /b 1
    )

    cd backend
    python -m venv venv
    venv\Scripts\python.exe -m pip install --upgrade pip
    venv\Scripts\python.exe -m pip install -r requirements.txt
    if !errorlevel! neq 0 (
        echo [错误] 后端依赖安装失败
        echo.
        pause
        exit /b 1
    )
    cd ..
    echo [2/3] 后端环境就绪
) else (
    echo [2/3] 后端环境已存在,跳过
)

REM 启动服务
echo [3/3] 启动服务...
echo.
echo ========================================
echo   访问地址: http://127.0.0.1:8000
echo   按 Ctrl+C 停止服务
echo ========================================
echo.

backend\venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --app-dir backend

REM 如果 uvicorn 退出了(异常或 Ctrl+C),暂停让用户看到输出
echo.
echo 服务已停止。
pause
endlocal
