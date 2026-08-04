@echo off
chcp 65001 >nul
setlocal

set "UPDATER_ROOT=%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%UPDATER_ROOT%update-portable.ps1"
set "EXIT_CODE=%errorlevel%"

echo.
if "%EXIT_CODE%"=="0" (
    echo 更新成功。新版本已启动，完整旧版本备份已保留。
) else (
    echo 更新失败。安装目录应保持原状或已自动回滚，请查看更新日志。
)
echo 按任意键关闭窗口。
pause >nul

exit /b %EXIT_CODE%
