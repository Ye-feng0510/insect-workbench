param(
    [string]$Version = "v1.2.0",
    [string]$BuildPython = "",
    [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$buildRoot = Join-Path $projectRoot ".portable-build"
$cacheRoot = Join-Path $buildRoot "cache"
$stageRoot = Join-Path $buildRoot "stage"
$packageName = "insect-workbench-portable-$Version-windows-x64"
$packageRoot = Join-Path $stageRoot $packageName
$pythonRoot = Join-Path $packageRoot "runtime\python"
$sitePackages = Join-Path $pythonRoot "Lib\site-packages"
$wheelCache = Join-Path $cacheRoot "wheels"
$pythonArchive = Join-Path $cacheRoot "python-3.12.10-embed-amd64.zip"
$pythonUrl = "https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip"
$pythonSha256 = "4ACBED6DD1C744B0376E3B1CF57CE906F9DC9E95E68824584C8099A63025A3C3"
$utf8 = New-Object System.Text.UTF8Encoding($false)
$utf8Bom = New-Object System.Text.UTF8Encoding($true)

if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $projectRoot "portable-dist"
}
if (-not $BuildPython) {
    $venvPython = Join-Path $projectRoot "backend\venv\Scripts\python.exe"
    $BuildPython = if (Test-Path -LiteralPath $venvPython) {
        $venvPython
    }
    else {
        "python"
    }
}

New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
New-Item -ItemType Directory -Path $wheelCache -Force | Out-Null
New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

Write-Host "[1/7] 构建生产前端..."
& pnpm --dir (Join-Path $projectRoot "frontend") install --frozen-lockfile
if ($LASTEXITCODE -ne 0) {
    throw "前端依赖安装失败。"
}
& pnpm --dir (Join-Path $projectRoot "frontend") build
if ($LASTEXITCODE -ne 0) {
    throw "前端构建失败。"
}

Write-Host "[2/7] 准备官方 CPython 3.12.10 x64..."
if (-not (Test-Path -LiteralPath $pythonArchive -PathType Leaf)) {
    Invoke-WebRequest -UseBasicParsing -Uri $pythonUrl -OutFile $pythonArchive
}
$actualPythonHash = (Get-FileHash -LiteralPath $pythonArchive -Algorithm SHA256).Hash
if ($actualPythonHash -ne $pythonSha256) {
    throw "内置 Python 压缩包校验失败。"
}

if (Test-Path -LiteralPath $packageRoot) {
    Remove-Item -LiteralPath $packageRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $pythonRoot -Force | Out-Null
Expand-Archive -LiteralPath $pythonArchive -DestinationPath $pythonRoot

$pthFile = Join-Path $pythonRoot "python312._pth"
[IO.File]::WriteAllLines(
    $pthFile,
    @(
        "python312.zip"
        "."
        "Lib\site-packages"
        "..\.."
        "import site"
    ),
    $utf8
)
New-Item -ItemType Directory -Path $sitePackages -Force | Out-Null

Write-Host "[3/7] 安装锁定的 Windows x64 依赖..."
$lockFile = Join-Path $PSScriptRoot "portable\requirements-win64.lock.txt"
$antlrWheel = Get-ChildItem -LiteralPath $wheelCache `
    -Filter "antlr4_python3_runtime-4.9.3-py3-none-any.whl" `
    -File -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $antlrWheel) {
    & $BuildPython -m pip wheel `
        --wheel-dir $wheelCache `
        --no-deps `
        "antlr4-python3-runtime==4.9.3"
    if ($LASTEXITCODE -ne 0) {
        throw "ANTLR 运行时构建失败。"
    }
}
& $BuildPython -m pip install `
    --target $sitePackages `
    --only-binary=:all: `
    --find-links $wheelCache `
    --platform win_amd64 `
    --python-version 3.12 `
    --implementation cp `
    --abi cp312 `
    --no-deps `
    --requirement $lockFile
if ($LASTEXITCODE -ne 0) {
    throw "便携运行时依赖安装失败。"
}

Write-Host "[4/7] 复制应用和启动文件..."
New-Item -ItemType Directory -Path (Join-Path $packageRoot "backend") -Force |
    Out-Null
New-Item -ItemType Directory -Path (Join-Path $packageRoot "frontend") -Force |
    Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot "backend\app") `
    -Destination (Join-Path $packageRoot "backend\app") -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot "frontend\dist") `
    -Destination (Join-Path $packageRoot "frontend\dist") -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot ".env.example") `
    -Destination (Join-Path $packageRoot ".env.example")
Copy-Item -LiteralPath (Join-Path $projectRoot "README.md") `
    -Destination (Join-Path $packageRoot "项目说明.md")
$launcherSource = Join-Path $PSScriptRoot "portable\start-portable.ps1"
$launcherDestination = Join-Path $packageRoot "start-portable.ps1"
$launcherContent = [IO.File]::ReadAllText($launcherSource) `
    -replace "`r?`n", "`r`n"
[IO.File]::WriteAllText($launcherDestination, $launcherContent, $utf8Bom)
$batchSource = Join-Path $PSScriptRoot "portable\start-portable.bat"
$batchDestination = Join-Path $packageRoot "启动昆虫标本工作台.bat"
$batchContent = [IO.File]::ReadAllText($batchSource) -replace "`r?`n", "`r`n"
[IO.File]::WriteAllText($batchDestination, $batchContent, $utf8)
Copy-Item -LiteralPath (
    Join-Path $PSScriptRoot "portable\便携版使用说明.txt"
) -Destination (Join-Path $packageRoot "便携版使用说明.txt")
$release = [ordered]@{
    product = "insect-specimen-workbench"
    version = $Version
    arch = "windows-x64"
}
$releaseJson = $release | ConvertTo-Json
[IO.File]::WriteAllText(
    (Join-Path $packageRoot "release.json"),
    $releaseJson + "`n",
    $utf8
)

Write-Host "[5/7] 验证隔离运行时..."
$env:INSECT_PORTABLE_SCRIPT_TO_PARSE = $launcherDestination
try {
    & powershell.exe -NoLogo -NoProfile -Command @'
$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile(
    $env:INSECT_PORTABLE_SCRIPT_TO_PARSE,
    [ref]$tokens,
    [ref]$errors
)
if ($errors.Count -gt 0) {
    $errors | ForEach-Object { Write-Error $_.Message }
    exit 1
}
'@
    if ($LASTEXITCODE -ne 0) {
        throw "启动脚本不兼容 Windows PowerShell 5.1。"
    }
}
finally {
    Remove-Item Env:INSECT_PORTABLE_SCRIPT_TO_PARSE -ErrorAction SilentlyContinue
}
$embeddedPython = Join-Path $pythonRoot "python.exe"
$smokeCode = @"
import pathlib
import struct
import sys
import argon2
import fastapi
import openpyxl
import numpy
import onnxruntime
import PIL
import pydantic
import rapidocr
import sqlalchemy
import uvicorn
root = pathlib.Path(sys.executable).resolve().parents[2]
assert struct.calcsize("P") * 8 == 64
assert sys.version_info[:3] == (3, 12, 10)
assert (root / "backend" / "app" / "main.py").is_file()
assert (root / "frontend" / "dist" / "index.html").is_file()
print(sys.version)
"@
& $embeddedPython -I -B -c $smokeCode
if ($LASTEXITCODE -ne 0) {
    throw "内置运行时导入检查失败。"
}
Get-ChildItem -LiteralPath $packageRoot -Recurse -Directory `
    -Filter "__pycache__" | Remove-Item -Recurse -Force
Get-ChildItem -LiteralPath $packageRoot -Recurse -File -Include "*.pyc", "*.pyo" |
    Remove-Item -Force

Write-Host "[6/7] 扫描便携包敏感文件..."
$forbidden = Get-ChildItem -LiteralPath $packageRoot -Recurse -Force |
    Where-Object {
        $_.Name -in @(".env", "app.db") -or
        $_.FullName -match "[\\/](test-data|node_modules|venv)[\\/]"
    }
if ($forbidden) {
    throw "便携包包含不应发布的文件：$($forbidden.FullName -join ', ')"
}

Write-Host "[7/7] 创建压缩包..."
$archive = Join-Path $OutputDirectory "$packageName.zip"
if (Test-Path -LiteralPath $archive) {
    Remove-Item -LiteralPath $archive -Force
}
Compress-Archive -LiteralPath $packageRoot -DestinationPath $archive `
    -CompressionLevel Optimal

$archiveHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
$archiveSize = (Get-Item -LiteralPath $archive).Length
Write-Host ""
Write-Host "便携版构建完成：$archive" -ForegroundColor Green
Write-Host "大小：$archiveSize 字节"
Write-Host "SHA-256：$archiveHash"
