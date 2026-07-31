@echo off
chcp 65001 >nul
setlocal

set "PROJECT_ROOT=%~dp0.."
cd /d "%PROJECT_ROOT%" || goto project_root_error

echo ========================================
echo   昆虫标本工作台 启动脚本
echo ========================================
echo.

REM Docker 与本地服务共享 8000 端口,先识别健康的项目容器。
docker inspect --format "{{.State.Running}}" insect-workbench 2>nul | findstr /x "true" >nul
if not errorlevel 1 goto check_docker_health
goto check_port

:check_docker_health
powershell -NoProfile -Command "try { $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8000/api/health' -TimeoutSec 2; if ($response.StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>&1
if not errorlevel 1 goto docker_running

:check_port
set "PORT_PID="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":8000 " ^| findstr "LISTENING"') do if not defined PORT_PID set "PORT_PID=%%P"
if defined PORT_PID goto port_in_use

:prepare_frontend
REM dist 缺失或前端输入更新时才重新安装依赖并构建。
powershell -NoProfile -Command "$dist = 'frontend/dist/index.html'; if (-not (Test-Path $dist)) { exit 1 }; $built = (Get-Item $dist).LastWriteTimeUtc; $inputs = @(Get-ChildItem 'frontend' -File) + @(Get-ChildItem 'frontend/src' -Recurse -File); if ($inputs | Where-Object { $_.LastWriteTimeUtc -gt $built } | Select-Object -First 1) { exit 1 }; exit 0" >nul 2>&1
if not errorlevel 1 goto frontend_ready

echo [1/3] 前端需要更新,开始构建...
where pnpm >nul 2>&1
if errorlevel 1 goto pnpm_missing
pushd frontend
call pnpm install --frozen-lockfile
if errorlevel 1 goto frontend_install_error
call pnpm build
if errorlevel 1 goto frontend_build_error
popd
echo [1/3] 前端构建完成
goto prepare_backend

:frontend_ready
echo [1/3] 前端构建为最新

:prepare_backend
if exist "backend\venv\Scripts\python.exe" goto check_backend_dependencies

echo [2/3] 创建后端虚拟环境...
where python >nul 2>&1
if errorlevel 1 goto python_missing
pushd backend
python -m venv venv
if errorlevel 1 goto backend_venv_error
venv\Scripts\python.exe -m pip install --upgrade pip
if errorlevel 1 goto backend_new_install_error
venv\Scripts\python.exe -m pip install -r requirements.txt
if errorlevel 1 goto backend_new_install_error
popd
echo [2/3] 后端环境就绪
goto start_service

:check_backend_dependencies
backend\venv\Scripts\python.exe -c "import argon2" >nul 2>&1
if errorlevel 1 goto refresh_backend_dependencies
backend\venv\Scripts\python.exe -m pip check >nul 2>&1
if errorlevel 1 goto refresh_backend_dependencies
echo [2/3] 后端依赖检查通过
goto start_service

:refresh_backend_dependencies
echo [2/3] 后端依赖需要更新...
backend\venv\Scripts\python.exe -m pip install -r backend\requirements.txt
if errorlevel 1 goto backend_install_error
echo [2/3] 后端依赖更新完成

:start_service
echo [3/3] 启动服务...
echo.
echo ========================================
echo   访问地址: http://127.0.0.1:8000
echo   按 Ctrl+C 停止服务
echo ========================================
echo.

backend\venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --app-dir backend
set "SERVICE_EXIT=%errorlevel%"

echo.
echo 服务已停止。
pause
exit /b %SERVICE_EXIT%

:docker_running
echo [信息] 项目已通过 Docker 正常运行。
echo.
echo   访问地址: http://127.0.0.1:8000
echo   代码更新后请执行: docker compose up -d --build
echo.
pause
exit /b 0

:port_in_use
set "PORT_PROCESS=未知"
for /f "tokens=1 delims=," %%N in ('tasklist /FI "PID eq %PORT_PID%" /FO CSV /NH 2^>nul') do set "PORT_PROCESS=%%~N"
echo [错误] 端口 8000 已被其他程序占用。
echo.
echo   PID: %PORT_PID%
echo   进程: %PORT_PROCESS%
echo.
echo 请关闭该程序或先停止对应服务,然后重试。
echo.
pause
exit /b 1

:pnpm_missing
echo [错误] 未找到 pnpm,请先安装 Node.js 和 pnpm。
echo   npm install -g pnpm
goto failed

:python_missing
echo [错误] 未找到 Python,请先安装 Python 3.12+。
echo   https://www.python.org/downloads/
goto failed

:frontend_install_error
popd
echo [错误] 前端依赖安装失败。
goto failed

:frontend_build_error
popd
echo [错误] 前端构建失败。
goto failed

:backend_venv_error
popd
echo [错误] 后端虚拟环境创建失败。
goto failed

:backend_new_install_error
popd
echo [错误] 后端依赖安装失败。
goto failed

:backend_install_error
echo [错误] 后端依赖安装失败。
goto failed

:project_root_error
echo [错误] 无法进入项目目录。

:failed
echo.
pause
exit /b 1
