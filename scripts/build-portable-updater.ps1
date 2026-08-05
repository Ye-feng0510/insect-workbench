param(
    [Parameter(Mandatory = $true)]
    [string]$Version,
    [Parameter(Mandatory = $true)]
    [string]$PortableArchive,
    [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $projectRoot "portable-dist"
}
$PortableArchive = [IO.Path]::GetFullPath($PortableArchive)
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$buildRoot = Join-Path $projectRoot ".portable-build\updater"
$extractRoot = Join-Path $buildRoot "extracted"
$packageRoot = Join-Path $buildRoot "package"
$payloadRoot = Join-Path $packageRoot "payload"
$archiveName = "insect-workbench-updater-$Version-windows-x64.zip"
$outputArchive = Join-Path $OutputDirectory $archiveName
$utf8 = New-Object System.Text.UTF8Encoding($false)
$utf8Bom = New-Object System.Text.UTF8Encoding($true)

function Assert-NoReparsePoints([string]$Root, [string]$Description) {
    $items = @(
        Get-Item -LiteralPath $Root -Force
        Get-ChildItem -LiteralPath $Root -Recurse -Force
    )
    foreach ($item in $items) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "$Description contains a reparse point: $($item.FullName)"
        }
    }
}

function Get-RelativeSlashPath([string]$Root, [string]$Path) {
    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd("\", "/") + "\"
    $rootUri = New-Object Uri($rootFull)
    $pathUri = New-Object Uri([IO.Path]::GetFullPath($Path))
    return [Uri]::UnescapeDataString(
        $rootUri.MakeRelativeUri($pathUri).ToString()
    ).Replace("\", "/")
}

function Copy-TextFile(
    [string]$Source,
    [string]$Destination,
    [Text.Encoding]$Encoding
) {
    $content = [IO.File]::ReadAllText($Source) -replace "`r?`n", "`r`n"
    [IO.File]::WriteAllText($Destination, $content, $Encoding)
}

function Assert-PowerShell51Parse([string]$Path) {
    $env:INSECT_UPDATER_SCRIPT_TO_PARSE = $Path
    try {
        & powershell.exe -NoLogo -NoProfile -Command @'
$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile(
    $env:INSECT_UPDATER_SCRIPT_TO_PARSE,
    [ref]$tokens,
    [ref]$errors
)
if ($errors.Count -gt 0) {
    $errors | ForEach-Object { Write-Error $_.Message }
    exit 1
}
'@
        if ($LASTEXITCODE -ne 0) {
            throw "Updater script is not compatible with Windows PowerShell 5.1."
        }
    }
    finally {
        Remove-Item Env:INSECT_UPDATER_SCRIPT_TO_PARSE `
            -ErrorAction SilentlyContinue
    }
}

if (-not (Test-Path -LiteralPath $PortableArchive -PathType Leaf)) {
    throw "Portable archive does not exist: $PortableArchive"
}

if (Test-Path -LiteralPath $buildRoot) {
    Remove-Item -LiteralPath $buildRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $extractRoot -Force | Out-Null
New-Item -ItemType Directory -Path $payloadRoot -Force | Out-Null
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

Write-Host "[1/5] Extracting and validating full portable archive..."
Expand-Archive -LiteralPath $PortableArchive -DestinationPath $extractRoot
$topLevel = @(Get-ChildItem -LiteralPath $extractRoot -Force)
if ($topLevel.Count -ne 1 -or -not $topLevel[0].PSIsContainer) {
    throw "Portable archive must contain exactly one top-level package directory."
}
$portableRoot = $topLevel[0].FullName
Assert-NoReparsePoints $portableRoot "Portable archive"

$releasePath = Join-Path $portableRoot "release.json"
if (-not (Test-Path -LiteralPath $releasePath -PathType Leaf)) {
    throw "Portable archive has no release.json. Rebuild it with build-portable.ps1."
}
$release = Get-Content -LiteralPath $releasePath -Raw -Encoding UTF8 |
    ConvertFrom-Json
if ([string]$release.product -ne "insect-specimen-workbench") {
    throw "Portable release.json has an unexpected product."
}
if ([string]$release.version -ne $Version) {
    throw "Portable release version '$($release.version)' does not match '$Version'."
}
if ([string]$release.arch -ne "windows-x64") {
    throw "Portable release.json has an unsupported architecture."
}
foreach ($mutable in @(".env", "data")) {
    if (Test-Path -LiteralPath (Join-Path $portableRoot $mutable)) {
        throw "Portable payload illegally contains mutable path: $mutable"
    }
}
foreach ($required in @(
    "runtime\python\python.exe",
    "backend\app\main.py",
    "frontend\dist\index.html",
    "start-portable.ps1"
)) {
    if (-not (Test-Path -LiteralPath (Join-Path $portableRoot $required) -PathType Leaf)) {
        throw "Portable archive is incomplete; missing: $required"
    }
}

Write-Host "[2/5] Preparing updater payload..."
Get-ChildItem -LiteralPath $portableRoot -Force |
    ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $payloadRoot `
            -Recurse -Force
    }
Assert-NoReparsePoints $payloadRoot "Updater payload"
foreach ($mutable in @(".env", "data")) {
    if (Test-Path -LiteralPath (Join-Path $payloadRoot $mutable)) {
        throw "Updater payload illegally contains mutable path: $mutable"
    }
}

$portableScripts = Join-Path $PSScriptRoot "portable"
$updaterSource = Join-Path $portableScripts "update-portable.ps1"
$batchSource = Join-Path $portableScripts "update-portable.bat"
$inspectorSource = Join-Path $portableScripts "inspect-portable-state.py"
foreach ($source in @($updaterSource, $batchSource, $inspectorSource)) {
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Updater source file is missing: $source"
    }
}
Copy-TextFile $updaterSource (Join-Path $packageRoot "update-portable.ps1") $utf8Bom
Copy-TextFile $batchSource (Join-Path $packageRoot "update-portable.bat") $utf8
$inspectorContent = [IO.File]::ReadAllText($inspectorSource) `
    -replace "`r?`n", "`n"
[IO.File]::WriteAllText(
    (Join-Path $packageRoot "inspect-portable-state.py"),
    $inspectorContent,
    $utf8
)

Write-Host "[3/5] Generating deterministic payload manifest..."
$manifestFiles = @(
    Get-ChildItem -LiteralPath $payloadRoot -Recurse -Force -File |
        ForEach-Object {
            [PSCustomObject]@{
                path = Get-RelativeSlashPath $payloadRoot $_.FullName
                size = [Int64]$_.Length
                sha256 = (
                    Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256
                ).Hash.ToLowerInvariant()
            }
        } |
        Sort-Object path
)
$manifest = [ordered]@{
    format_version = 1
    product = [string]$release.product
    version = [string]$release.version
    arch = [string]$release.arch
    health = [ordered]@{
        url = "http://127.0.0.1:8000/api/health"
        app = "昆虫标本图片识别与Excel录入工作台"
        status = "ok"
        version = [string]$release.version
        capability = "agent_workflows_v1"
    }
    mutable_paths = @(".env", "data")
    files = $manifestFiles
}
$manifestJson = $manifest | ConvertTo-Json -Depth 10
[IO.File]::WriteAllText(
    (Join-Path $packageRoot "manifest.json"),
    $manifestJson + "`n",
    $utf8
)

Write-Host "[4/5] Validating Windows PowerShell 5.1 syntax..."
Assert-PowerShell51Parse (Join-Path $packageRoot "update-portable.ps1")

Write-Host "[5/5] Creating updater archive..."
if (Test-Path -LiteralPath $outputArchive) {
    Remove-Item -LiteralPath $outputArchive -Force
}
$archiveEntries = @(
    Get-ChildItem -LiteralPath $packageRoot -Force |
        ForEach-Object { $_.FullName }
)
Compress-Archive -LiteralPath $archiveEntries -DestinationPath $outputArchive `
    -CompressionLevel Optimal

$archiveHash = (
    Get-FileHash -LiteralPath $outputArchive -Algorithm SHA256
).Hash
$archiveSize = (Get-Item -LiteralPath $outputArchive).Length
Write-Host ""
Write-Host "Updater build completed: $outputArchive" -ForegroundColor Green
Write-Host "Size: $archiveSize bytes"
Write-Host "SHA-256: $archiveHash"
