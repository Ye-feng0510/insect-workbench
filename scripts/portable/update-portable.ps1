param(
    [string]$InstallRoot = "",
    [switch]$NonInteractive,
    [switch]$NoBrowser,
    [ValidateRange(10, 600)]
    [int]$HealthTimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0
$PayloadSchemaVersion = 6

$updaterRoot = $PSScriptRoot
$manifestPath = Join-Path $updaterRoot "manifest.json"
$payloadRoot = Join-Path $updaterRoot "payload"
$inspectorPath = Join-Path $updaterRoot "inspect-portable-state.py"
$expectedApp = "昆虫标本图片识别与Excel录入工作台"
$expectedCapability = "agent_workflows_v1"
$healthUrl = "http://127.0.0.1:8000/api/health"
$utf8 = New-Object System.Text.UTF8Encoding($false)
$journalPath = $null
$logPath = $null
$stageRoot = $null
$backupRoot = $null
$failedRoot = $null
$oldMoved = $false
$newInstalled = $false
$validationLauncher = $null
$startedLauncher = $null
$lockHandle = $null

function Get-FullPath([string]$Path) {
    return [IO.Path]::GetFullPath($Path).TrimEnd(
        [IO.Path]::DirectorySeparatorChar,
        [IO.Path]::AltDirectorySeparatorChar
    )
}

function ConvertTo-WindowsCommandLineArgument([string]$Argument) {
    if ($Argument.Length -eq 0) {
        return '""'
    }
    if ($Argument -notmatch '[\s"]') {
        return $Argument
    }

    $encoded = New-Object Text.StringBuilder
    [void]$encoded.Append('"')
    $backslashes = 0
    foreach ($character in $Argument.ToCharArray()) {
        if ($character -eq [char]92) {
            $backslashes++
            continue
        }
        if ($character -eq '"') {
            [void]$encoded.Append([char]92, (2 * $backslashes) + 1)
            [void]$encoded.Append('"')
        }
        else {
            [void]$encoded.Append([char]92, $backslashes)
            [void]$encoded.Append($character)
        }
        $backslashes = 0
    }
    [void]$encoded.Append([char]92, 2 * $backslashes)
    [void]$encoded.Append('"')
    return $encoded.ToString()
}

function Test-SamePath([string]$Left, [string]$Right) {
    return [string]::Equals(
        (Get-FullPath $Left),
        (Get-FullPath $Right),
        [StringComparison]::OrdinalIgnoreCase
    )
}

function Test-PathInside([string]$Candidate, [string]$Container) {
    $candidateFull = (Get-FullPath $Candidate) + [IO.Path]::DirectorySeparatorChar
    $containerFull = (Get-FullPath $Container) + [IO.Path]::DirectorySeparatorChar
    return $candidateFull.StartsWith(
        $containerFull,
        [StringComparison]::OrdinalIgnoreCase
    )
}

function Write-Log([string]$Message, [ConsoleColor]$Color = [ConsoleColor]::Gray) {
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
    Write-Host $Message -ForegroundColor $Color
    if ($logPath) {
        [IO.File]::AppendAllText($logPath, $line + "`r`n", $utf8)
    }
}

function Write-JsonAtomic([string]$Path, $Value) {
    $temporary = "$Path.tmp-$PID-$([Guid]::NewGuid().ToString('N'))"
    try {
        $json = $Value | ConvertTo-Json -Depth 20
        [IO.File]::WriteAllText($temporary, $json + "`n", $utf8)
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    }
    finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
}

function Write-Journal([string]$Phase, [string]$Detail = "") {
    $journal = [ordered]@{
        format_version = 1
        phase = $Phase
        detail = $Detail
        updated_at_utc = [DateTime]::UtcNow.ToString("o")
        install_root = $InstallRoot
        staging_root = $stageRoot
        backup_root = $backupRoot
        failed_root = $failedRoot
    }
    Write-JsonAtomic $journalPath $journal
}

function Assert-RegularTree([string]$Root, [string]$Description) {
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

function Copy-RegularTreeLongPath(
    [string]$Python,
    [string]$Source,
    [string]$Destination
) {
    $copyScript = @'
import os
import shutil
import stat
import sys

reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)

def extended_path(path):
    absolute = os.path.abspath(path)
    if os.name != "nt" or absolute.startswith("\\\\?\\"):
        return absolute
    if absolute.startswith("\\\\"):
        return "\\\\?\\UNC\\" + absolute[2:]
    return "\\\\?\\" + absolute

source = extended_path(sys.argv[1])
destination = extended_path(sys.argv[2])

def checked_stat(path):
    value = os.stat(path, follow_symlinks=False)
    if stat.S_ISLNK(value.st_mode) or (
        getattr(value, "st_file_attributes", 0) & reparse_flag
    ):
        raise RuntimeError("refusing to copy reparse point: " + path)
    return value

def copy_file(source_file, destination_file):
    value = checked_stat(source_file)
    if not stat.S_ISREG(value.st_mode):
        raise RuntimeError("refusing to copy non-regular file: " + source_file)
    if os.path.lexists(destination_file):
        raise RuntimeError("destination already exists: " + destination_file)
    shutil.copyfile(source_file, destination_file, follow_symlinks=False)
    shutil.copystat(
        source_file,
        destination_file,
        follow_symlinks=False,
    )

def copy_tree(source_directory, destination_directory):
    value = checked_stat(source_directory)
    if not stat.S_ISDIR(value.st_mode):
        raise RuntimeError("source is not a directory: " + source_directory)
    if os.path.lexists(destination_directory):
        raise RuntimeError("destination already exists: " + destination_directory)
    os.mkdir(destination_directory)
    with os.scandir(source_directory) as entries:
        for entry in entries:
            source_path = entry.path
            destination_path = os.path.join(destination_directory, entry.name)
            entry_stat = checked_stat(source_path)
            if stat.S_ISDIR(entry_stat.st_mode):
                copy_tree(source_path, destination_path)
            elif stat.S_ISREG(entry_stat.st_mode):
                copy_file(source_path, destination_path)
            else:
                raise RuntimeError(
                    "refusing to copy non-regular entry: " + source_path
                )
    shutil.copystat(
        source_directory,
        destination_directory,
        follow_symlinks=False,
    )

source_stat = checked_stat(source)
if stat.S_ISDIR(source_stat.st_mode):
    copy_tree(source, destination)
elif stat.S_ISREG(source_stat.st_mode):
    copy_file(source, destination)
else:
    raise RuntimeError("source is not a regular file or directory: " + source)
'@
    $temporaryScript = [IO.Path]::GetTempFileName()
    try {
        [IO.File]::WriteAllText(
            $temporaryScript,
            $copyScript,
            (New-Object Text.UTF8Encoding($false))
        )
        & $Python -I -B $temporaryScript $Source $Destination
        if ($LASTEXITCODE -ne 0) {
            throw (
                "Long-path-safe staging copy failed from '$Source' to " +
                "'$Destination' (exit code $LASTEXITCODE)."
            )
        }
    }
    finally {
        Remove-Item -LiteralPath $temporaryScript -Force `
            -ErrorAction SilentlyContinue
    }
}

function Get-RelativeSlashPath([string]$Root, [string]$Path) {
    $rootWithSlash = (Get-FullPath $Root) + [IO.Path]::DirectorySeparatorChar
    $rootUri = New-Object Uri($rootWithSlash)
    $pathUri = New-Object Uri((Get-FullPath $Path))
    return [Uri]::UnescapeDataString(
        $rootUri.MakeRelativeUri($pathUri).ToString()
    ).Replace("\", "/")
}

function Get-TreeBytes([string]$Root) {
    $sum = [Int64]0
    Get-ChildItem -LiteralPath $Root -Recurse -Force -File |
        ForEach-Object { $sum += $_.Length }
    return $sum
}

function Get-DataFingerprint([string]$Root) {
    $dataRoot = Join-Path $Root "data"
    $result = [ordered]@{}
    Get-ChildItem -LiteralPath $dataRoot -Recurse -Force -File |
        Sort-Object FullName |
        ForEach-Object {
            if ($_.Name -notin @("app.db", "app.db-wal", "app.db-shm")) {
                $relative = Get-RelativeSlashPath $dataRoot $_.FullName
                $result[$relative] = [ordered]@{
                    size = [Int64]$_.Length
                    sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
                }
            }
        }
    return $result
}

function Convert-FingerprintToCanonical($Fingerprint) {
    return ($Fingerprint | ConvertTo-Json -Depth 10 -Compress)
}

function Assert-FingerprintPreserved($Before, $After) {
    foreach ($relative in $Before.Keys) {
        if (-not $After.Contains($relative)) {
            throw "Non-database data file disappeared during update: $relative"
        }
        $beforeValue = $Before[$relative] | ConvertTo-Json -Compress
        $afterValue = $After[$relative] | ConvertTo-Json -Compress
        if ($beforeValue -ne $afterValue) {
            throw "Non-database data file changed during update: $relative"
        }
    }
}

function Invoke-Inspector([string]$Root, [string]$Output) {
    $python = Join-Path $Root "runtime\python\python.exe"
    & $python -I -B $inspectorPath --root $Root --output $Output
    if ($LASTEXITCODE -ne 0) {
        throw "State inspection failed for: $Root"
    }
    return Get-Content -LiteralPath $Output -Raw -Encoding UTF8 |
        ConvertFrom-Json
}

function Get-PortListener([int]$Port = 8000) {
    return Get-NetTCPConnection -LocalPort $Port -State Listen `
        -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Get-AvailableLoopbackPort {
    $listener = New-Object Net.Sockets.TcpListener(
        [Net.IPAddress]::Loopback,
        0
    )
    try {
        $listener.Start()
        return [int]$listener.LocalEndpoint.Port
    }
    finally {
        $listener.Stop()
    }
}

function Get-ProcessExecutable([int]$ProcessId) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" `
        -ErrorAction SilentlyContinue
    if (-not $process -or -not $process.ExecutablePath) {
        return $null
    }
    return Get-FullPath ([string]$process.ExecutablePath)
}

function Stop-OwnedListener(
    [string]$Root,
    [switch]$Required,
    [int]$Port = 8000
) {
    $listener = Get-PortListener $Port
    if (-not $listener) {
        return
    }
    $expectedPython = Join-Path $Root "runtime\python\python.exe"
    $actualExecutable = Get-ProcessExecutable $listener.OwningProcess
    if (-not $actualExecutable -or -not (Test-SamePath $actualExecutable $expectedPython)) {
        if ($Required) {
            $ownerPath = if ($actualExecutable) {
                $actualExecutable
            }
            else {
                "<unavailable>"
            }
            throw (
                "Port 8000 is owned by another executable ($ownerPath, " +
                "PID $($listener.OwningProcess)); update aborted without changing files."
            )
        }
        return
    }
    Write-Log "Stopping portable application process $($listener.OwningProcess) on port $Port..."
    Stop-Process -Id $listener.OwningProcess -ErrorAction Stop
    try {
        Wait-Process -Id $listener.OwningProcess -Timeout 10 `
            -ErrorAction SilentlyContinue
    }
    catch {
    }
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        if (-not (Get-PortListener $Port)) {
            return
        }
        Start-Sleep -Milliseconds 250
    }
    throw "Portable application did not release port $Port."
}

function Start-UpdatedBackend(
    [string]$Python,
    [string]$Backend,
    [int]$Port,
    [switch]$SuppressBrowser
) {
    $launchArguments = @(
        "-I", "-B",
        "-m", "uvicorn", "app.main:app",
        "--host", "127.0.0.1", "--port", ([string]$Port),
        "--app-dir", $Backend
    ) | ForEach-Object {
        ConvertTo-WindowsCommandLineArgument ([string]$_)
    }
    if ($SuppressBrowser) {
        $env:INSECT_PORTABLE_NO_BROWSER = "1"
    }
    try {
        return Start-Process -FilePath $Python `
            -ArgumentList ([string]::Join(" ", [string[]]$launchArguments)) `
            -WorkingDirectory $InstallRoot -PassThru `
            -WindowStyle Hidden
    }
    finally {
        if ($SuppressBrowser) {
            Remove-Item Env:INSECT_PORTABLE_NO_BROWSER `
                -ErrorAction SilentlyContinue
        }
    }
}

function Assert-OwnedBackendProcess(
    $Process,
    [string]$Root,
    [int]$Port,
    [switch]$RequireListener
) {
    if (-not $Process) {
        throw "Updated backend process handle is unavailable."
    }
    $Process.Refresh()
    if ($Process.HasExited) {
        throw "Updated backend PID $($Process.Id) exited unexpectedly."
    }
    $expectedPython = Join-Path $Root "runtime\python\python.exe"
    $actualExecutable = Get-ProcessExecutable $Process.Id
    if (
        -not $actualExecutable -or
        -not (Test-SamePath $actualExecutable $expectedPython)
    ) {
        throw (
            "PID $($Process.Id) is not owned by the updated portable runtime."
        )
    }
    $listener = Get-PortListener $Port
    if ($listener -and $listener.OwningProcess -ne $Process.Id) {
        throw (
            "Port $Port is owned by PID $($listener.OwningProcess), not " +
            "updated backend PID $($Process.Id)."
        )
    }
    if ($RequireListener -and -not $listener) {
        throw "Updated backend PID $($Process.Id) is not listening on port $Port."
    }
}

function Stop-OwnedBackendProcess(
    $Process,
    [string]$Root,
    [int]$Port
) {
    if (-not $Process) {
        return
    }
    $Process.Refresh()
    if ($Process.HasExited) {
        return
    }

    Assert-OwnedBackendProcess $Process $Root $Port
    $processId = $Process.Id
    Stop-Process -Id $processId -Force -ErrorAction Stop
    try {
        Wait-Process -Id $processId -Timeout 10 -ErrorAction Stop
    }
    catch {
        $Process.Refresh()
        if (-not $Process.HasExited) {
            throw "Updated backend PID $processId did not exit."
        }
    }
    $Process.Refresh()
    if (-not $Process.HasExited) {
        throw "Updated backend PID $processId did not exit."
    }
}

function Move-WithRetry([string]$Source, [string]$Destination) {
    $lastError = $null
    for ($attempt = 1; $attempt -le 12; $attempt++) {
        try {
            Move-Item -LiteralPath $Source -Destination $Destination
            return
        }
        catch {
            $lastError = $_
            if ($attempt -lt 12) {
                Start-Sleep -Milliseconds 500
            }
        }
    }
    throw "Unable to rename '$Source' to '$Destination': $lastError"
}

function Assert-RequiredInstall([string]$Root) {
    $requiredFiles = @(
        "runtime\python\python.exe",
        "backend\app\main.py",
        "frontend\dist\index.html",
        "start-portable.ps1",
        ".env",
        "data\app.db"
    )
    foreach ($relative in $requiredFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $Root $relative) -PathType Leaf)) {
            throw "Installed portable application is incomplete; missing: $relative"
        }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $Root "data") -PathType Container)) {
        throw "Installed portable application has no data directory."
    }
    Assert-RegularTree $Root "Installed portable application"
}

function Assert-Payload($Manifest) {
    if (-not (Test-Path -LiteralPath $payloadRoot -PathType Container)) {
        throw "Updater payload directory is missing."
    }
    if (-not (Test-Path -LiteralPath $inspectorPath -PathType Leaf)) {
        throw "Updater state inspector is missing."
    }
    Assert-RegularTree $payloadRoot "Updater payload"

    if (
        [int]$Manifest.format_version -ne 1 -or
        [string]$Manifest.product -ne "insect-specimen-workbench" -or
        [string]$Manifest.arch -ne "windows-x64" -or
        [string]$Manifest.health.url -ne $healthUrl -or
        [string]$Manifest.health.app -ne $expectedApp -or
        [string]$Manifest.health.status -ne "ok" -or
        [string]$Manifest.health.version -ne [string]$Manifest.version -or
        [string]$Manifest.health.capability -ne $expectedCapability
    ) {
        throw "Updater manifest metadata is invalid."
    }
    if (
        @($Manifest.mutable_paths).Count -ne 2 -or
        [string]$Manifest.mutable_paths[0] -ne ".env" -or
        [string]$Manifest.mutable_paths[1] -ne "data"
    ) {
        throw "Updater manifest mutable paths are invalid."
    }
    $release = Get-Content -LiteralPath (Join-Path $payloadRoot "release.json") `
        -Raw -Encoding UTF8 | ConvertFrom-Json
    if (
        [string]$release.product -ne [string]$Manifest.product -or
        [string]$release.version -ne [string]$Manifest.version -or
        [string]$release.arch -ne [string]$Manifest.arch
    ) {
        throw "Payload release.json does not match updater manifest."
    }

    foreach ($mutable in @(".env", "data")) {
        if (Test-Path -LiteralPath (Join-Path $payloadRoot $mutable)) {
            throw "Updater payload illegally contains mutable path: $mutable"
        }
    }
    $required = @(
        "release.json",
        "runtime\python\python.exe",
        "backend\app\main.py",
        "frontend\dist\index.html",
        "start-portable.ps1"
    )
    foreach ($relative in $required) {
        if (-not (Test-Path -LiteralPath (Join-Path $payloadRoot $relative) -PathType Leaf)) {
            throw "Updater payload is incomplete; missing: $relative"
        }
    }

    $listed = @{}
    foreach ($entry in @($Manifest.files)) {
        $relative = [string]$entry.path
        if (
            -not $relative -or
            $relative.Contains("\") -or
            $relative.Contains(":") -or
            $relative.StartsWith("/") -or
            $relative -match "(^|/)\.\.(/|$)" -or
            $relative -match "^(\.env|data)(/|$)"
        ) {
            throw "Manifest contains unsafe path: $relative"
        }
        $key = $relative.ToLowerInvariant()
        if ($listed.ContainsKey($key)) {
            throw "Manifest contains duplicate path: $relative"
        }
        $file = Join-Path $payloadRoot ($relative.Replace("/", "\"))
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
            throw "Manifest file is missing from payload: $relative"
        }
        $item = Get-Item -LiteralPath $file -Force
        if ([Int64]$entry.size -ne [Int64]$item.Length) {
            throw "Payload size mismatch: $relative"
        }
        if ([string]$entry.sha256 -notmatch "^[0-9a-fA-F]{64}$") {
            throw "Manifest SHA-256 is invalid: $relative"
        }
        $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
        if (-not [string]::Equals($hash, [string]$entry.sha256, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Payload SHA-256 mismatch: $relative"
        }
        $listed[$key] = $true
    }
    $actualFiles = @(
        Get-ChildItem -LiteralPath $payloadRoot -Recurse -Force -File
    )
    if ($actualFiles.Count -ne $listed.Count) {
        throw "Payload file set does not match manifest."
    }
    foreach ($file in $actualFiles) {
        $relative = Get-RelativeSlashPath $payloadRoot $file.FullName
        if (-not $listed.ContainsKey($relative.ToLowerInvariant())) {
            throw "Payload contains unlisted file: $relative"
        }
    }
}

function Assert-StateEquivalent(
    $Before,
    $After,
    [int]$MinimumSchemaVersion = 0
) {
    $beforeDb = $Before.database
    $afterDb = $After.database
    if (-not $afterDb.present -or -not $afterDb.integrity.ok) {
        throw "Updated database is missing or failed integrity_check."
    }
    if (
        $MinimumSchemaVersion -gt 0 -and
        [int]$afterDb.schema_version -lt $MinimumSchemaVersion
    ) {
        throw (
            "Updated database schema_version is below {0}." -f
            $MinimumSchemaVersion
        )
    }
    if (
        -not $beforeDb.app_settings_fingerprint.available -or
        -not $afterDb.app_settings_fingerprint.available -or
        $beforeDb.app_settings_fingerprint.sha256 -ne
            $afterDb.app_settings_fingerprint.sha256
    ) {
        throw "Application settings changed during update."
    }
    foreach ($table in @(
        "users", "excel_templates", "specimen_records", "taxonomy_cache",
        "material_batches", "material_items"
    )) {
        if ($beforeDb.table_row_counts.$table -ne $afterDb.table_row_counts.$table) {
            throw "Row count changed during update: $table"
        }
    }
    if ($beforeDb.completed_record_count -ne $afterDb.completed_record_count) {
        throw "Completed specimen count changed during update."
    }
    foreach ($table in @("specimen_records", "material_items")) {
        $beforeStatus = $beforeDb.status_counts.$table |
            ConvertTo-Json -Depth 5 -Compress
        $afterStatus = $afterDb.status_counts.$table |
            ConvertTo-Json -Depth 5 -Compress
        if ($beforeStatus -ne $afterStatus) {
            throw "Status counts changed during update: $table"
        }
    }
    $beforeExports = [Int64]$beforeDb.table_row_counts.export_artifacts
    $afterExports = [Int64]$afterDb.table_row_counts.export_artifacts
    if ($afterExports -lt $beforeExports) {
        throw "Export artifact count decreased during update."
    }
}

function Wait-AppHealth([string]$Url) {
    $deadline = (Get-Date).AddSeconds($HealthTimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $client = New-Object System.Net.WebClient
            $client.Encoding = [Text.Encoding]::UTF8
            $json = $client.DownloadString($Url)
            $response = $json | ConvertFrom-Json
            if (Test-AppHealthResponse $response $manifest.health) {
                return
            }
        }
        catch {
        }
        Start-Sleep -Milliseconds 500
    }
    throw "Updated application did not pass the exact health check within $HealthTimeoutSeconds seconds."
}

function Test-AppHealthResponse($Response, $ExpectedHealth) {
    $statusProperty = $Response.PSObject.Properties["status"]
    $appProperty = $Response.PSObject.Properties["app"]
    $versionProperty = $Response.PSObject.Properties["version"]
    $capabilityProperty = $Response.PSObject.Properties["capability"]
    $capabilitiesProperty = $Response.PSObject.Properties["capabilities"]
    $hasCapability = (
        (
            $capabilityProperty -and
            [string]$capabilityProperty.Value -eq
                [string]$ExpectedHealth.capability
        ) -or
        (
            $capabilitiesProperty -and
            @($capabilitiesProperty.Value) -contains
                [string]$ExpectedHealth.capability
        )
    )
    return (
        $statusProperty -and
        [string]$statusProperty.Value -eq [string]$ExpectedHealth.status -and
        $appProperty -and
        [string]$appProperty.Value -eq [string]$ExpectedHealth.app -and
        $versionProperty -and
        [string]$versionProperty.Value -eq [string]$ExpectedHealth.version -and
        $hasCapability
    )
}

function Test-LiveAppHealth($ExpectedHealth) {
    try {
        $client = New-Object System.Net.WebClient
        $client.Encoding = [Text.Encoding]::UTF8
        $json = $client.DownloadString([string]$ExpectedHealth.url)
        $response = $json | ConvertFrom-Json
        return Test-AppHealthResponse $response $ExpectedHealth
    }
    catch {
        return $false
    }
}

try {
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "manifest.json is missing."
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 |
        ConvertFrom-Json
    Assert-Payload $manifest

    if (-not $InstallRoot) {
        $candidate = Split-Path -Parent $updaterRoot
        if (
            (Test-Path -LiteralPath (Join-Path $candidate "runtime\python\python.exe") -PathType Leaf) -and
            (Test-Path -LiteralPath (Join-Path $candidate "start-portable.ps1") -PathType Leaf)
        ) {
            $InstallRoot = $candidate
        }
        elseif ($NonInteractive) {
            throw "-InstallRoot is required in noninteractive mode."
        }
        else {
            Add-Type -AssemblyName System.Windows.Forms
            $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
            $dialog.Description = "请选择昆虫标本工作台便携版安装目录"
            $dialog.ShowNewFolderButton = $false
            if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
                throw "No installation directory was selected."
            }
            $InstallRoot = $dialog.SelectedPath
        }
    }
    $InstallRoot = Get-FullPath $InstallRoot
    $updaterRoot = Get-FullPath $updaterRoot
    if (-not (Test-Path -LiteralPath $InstallRoot -PathType Container)) {
        throw "Installation directory does not exist: $InstallRoot"
    }
    if (
        (Test-SamePath $updaterRoot $InstallRoot) -or
        (Test-PathInside $updaterRoot $InstallRoot) -or
        (Test-PathInside $InstallRoot $updaterRoot)
    ) {
        throw "Updater and installation directories overlap. Move the updater folder outside the installation before retrying."
    }

    Assert-RequiredInstall $InstallRoot
    $parent = Split-Path -Parent $InstallRoot
    $leaf = Split-Path -Leaf $InstallRoot
    $lockPath = Join-Path $parent ".$leaf-update.lock"
    try {
        $lockHandle = [IO.File]::Open(
            $lockPath,
            [IO.FileMode]::OpenOrCreate,
            [IO.FileAccess]::ReadWrite,
            [IO.FileShare]::None
        )
    }
    catch {
        throw "Another updater is already operating on this installation."
    }

    $installedReleasePath = Join-Path $InstallRoot "release.json"
    if (Test-Path -LiteralPath $installedReleasePath -PathType Leaf) {
        $installedRelease = Get-Content -LiteralPath $installedReleasePath `
            -Raw -Encoding UTF8 | ConvertFrom-Json
        if (
            [string]$installedRelease.product -eq [string]$manifest.product -and
            [string]$installedRelease.version -eq [string]$manifest.version -and
            [string]$installedRelease.arch -eq [string]$manifest.arch
        ) {
            $listener = Get-PortListener
            $installedPython = Join-Path $InstallRoot "runtime\python\python.exe"
            $listenerExecutable = if ($listener) {
                Get-ProcessExecutable $listener.OwningProcess
            }
            else {
                $null
            }
            if (
                (Test-LiveAppHealth $manifest.health) -and
                $listener -and
                $listenerExecutable -and
                (Test-SamePath $listenerExecutable $installedPython)
            ) {
                Write-Host "The portable application is already version $($manifest.version)." `
                    -ForegroundColor Green
                $lockHandle.Dispose()
                $lockHandle = $null
                exit 0
            }
        }
    }

    $id = (Get-Date -Format "yyyyMMdd-HHmmss") + "-" +
        [Guid]::NewGuid().ToString("N").Substring(0, 8)
    $stageRoot = Join-Path $parent ".$leaf-update-stage-$id"
    $backupRoot = Join-Path $parent "$leaf-backup-$id"
    $failedRoot = Join-Path $parent "$leaf-failed-$id"
    $journalPath = Join-Path $parent ".$leaf-update-$id.journal.json"
    $logPath = Join-Path $parent ".$leaf-update-$id.log"
    [IO.File]::WriteAllText($logPath, "", $utf8)
    Write-Journal "preflight"
    Write-Log "Updating portable installation: $InstallRoot" Cyan

    $stateBytes = (Get-Item -LiteralPath (Join-Path $InstallRoot ".env")).Length +
        (Get-TreeBytes (Join-Path $InstallRoot "data"))
    $requiredBytes = [Int64][Math]::Ceiling(
        ([double](Get-TreeBytes $payloadRoot) + [double]$stateBytes) * 1.25
    ) + 104857600
    $drive = New-Object IO.DriveInfo([IO.Path]::GetPathRoot($InstallRoot))
    if ($drive.AvailableFreeSpace -lt $requiredBytes) {
        throw "Insufficient free space. Required conservatively: $requiredBytes bytes."
    }

    Stop-OwnedListener $InstallRoot -Required
    Write-Journal "old-stopped"
    $oldStatePath = Join-Path $parent ".$leaf-update-$id.old-state.json"
    $stagedStatePath = Join-Path $parent ".$leaf-update-$id.staged-state.json"
    $newStatePath = Join-Path $parent ".$leaf-update-$id.new-state.json"
    $oldState = Invoke-Inspector $InstallRoot $oldStatePath
    if (-not $oldState.database.present -or -not $oldState.database.integrity.ok) {
        throw "Installed database is missing or failed integrity_check."
    }
    $envHash = (Get-FileHash -LiteralPath (Join-Path $InstallRoot ".env") -Algorithm SHA256).Hash
    $dataFingerprint = Get-DataFingerprint $InstallRoot

    $trustedPython = Join-Path $payloadRoot "runtime\python\python.exe"
    Copy-RegularTreeLongPath $trustedPython $payloadRoot $stageRoot
    Copy-RegularTreeLongPath `
        $trustedPython `
        (Join-Path $InstallRoot ".env") `
        (Join-Path $stageRoot ".env")
    Copy-RegularTreeLongPath `
        $trustedPython `
        (Join-Path $InstallRoot "data") `
        (Join-Path $stageRoot "data")
    if (
        $envHash -ne
        (Get-FileHash -LiteralPath (Join-Path $stageRoot ".env") -Algorithm SHA256).Hash
    ) {
        throw "Staged .env differs from the installed .env."
    }
    $stagedFingerprint = Get-DataFingerprint $stageRoot
    if (
        (Convert-FingerprintToCanonical $dataFingerprint) -ne
        (Convert-FingerprintToCanonical $stagedFingerprint)
    ) {
        throw "Staged non-database data differs from installed data."
    }
    $stagedState = Invoke-Inspector $stageRoot $stagedStatePath
    Assert-StateEquivalent $oldState $stagedState
    Write-Journal "staged-and-verified"

    Move-WithRetry $InstallRoot $backupRoot
    $oldMoved = $true
    Write-Journal "old-renamed"
    Move-WithRetry $stageRoot $InstallRoot
    $newInstalled = $true
    Write-Journal "new-installed"

    $embeddedPython = Join-Path $InstallRoot "runtime\python\python.exe"
    $embeddedBackend = Join-Path $InstallRoot "backend"
    $validationPort = Get-AvailableLoopbackPort
    $validationHealthUrl = "http://127.0.0.1:$validationPort/api/health"
    Write-Log "Starting updated backend validation on loopback port $validationPort..."
    $validationLauncher = Start-UpdatedBackend `
        $embeddedPython $embeddedBackend $validationPort -SuppressBrowser
    Wait-AppHealth $validationHealthUrl
    Assert-OwnedBackendProcess `
        $validationLauncher $InstallRoot $validationPort -RequireListener
    $newState = Invoke-Inspector $InstallRoot $newStatePath
    Assert-StateEquivalent $oldState $newState `
        -MinimumSchemaVersion $PayloadSchemaVersion
    if (
        $envHash -ne
        (Get-FileHash -LiteralPath (Join-Path $InstallRoot ".env") -Algorithm SHA256).Hash
    ) {
        throw ".env changed during update."
    }
    $newFingerprint = Get-DataFingerprint $InstallRoot
    Assert-FingerprintPreserved $dataFingerprint $newFingerprint
    Stop-OwnedBackendProcess `
        $validationLauncher $InstallRoot $validationPort
    $validationLauncher = $null
    Write-Journal "validated"

    Stop-OwnedListener $InstallRoot -Required
    Write-Log "Starting updated backend on production port 8000..."
    $startedLauncher = Start-UpdatedBackend `
        $embeddedPython $embeddedBackend 8000 -SuppressBrowser:$NoBrowser
    Wait-AppHealth $healthUrl
    Assert-OwnedBackendProcess `
        $startedLauncher $InstallRoot 8000 -RequireListener

    Write-Journal "succeeded"
    Write-Log "Update succeeded. Live path: $InstallRoot" Green
    Write-Log "Complete cold backup retained at: $backupRoot" Green
    if ($lockHandle) {
        $lockHandle.Dispose()
        $lockHandle = $null
    }
    exit 0
}
catch {
    $failure = $_.Exception.Message
    if ($journalPath) {
        try { Write-Journal "failed" $failure } catch {}
    }
    if ($logPath) {
        try { Write-Log "Update failed: $failure" Red } catch {}
    }
    else {
        Write-Host "Update failed: $failure" -ForegroundColor Red
    }

    if ($oldMoved) {
        try {
            if ($newInstalled -and (Test-Path -LiteralPath $InstallRoot)) {
                if ($validationLauncher) {
                    try {
                        Stop-OwnedBackendProcess `
                            $validationLauncher $InstallRoot $validationPort
                    }
                    catch {}
                }
                if ($startedLauncher) {
                    try {
                        Stop-OwnedBackendProcess `
                            $startedLauncher $InstallRoot 8000
                    }
                    catch {}
                }
                Start-Sleep -Milliseconds 500
                Move-WithRetry $InstallRoot $failedRoot
            }
            if (-not (Test-Path -LiteralPath $InstallRoot)) {
                Move-WithRetry $backupRoot $InstallRoot
            }
            if ($journalPath) {
                Write-Journal "rolled-back" $failure
            }
            if ($logPath) {
                Write-Log "Complete backup restored to: $InstallRoot" Yellow
                if (Test-Path -LiteralPath $failedRoot) {
                    Write-Log "Failed updated tree retained at: $failedRoot" Yellow
                }
            }
        }
        catch {
            Write-Host "ROLLBACK ERROR: $($_.Exception.Message)" -ForegroundColor Red
            Write-Host "Backup remains at: $backupRoot" -ForegroundColor Red
        }
    }
    if ($lockHandle) {
        $lockHandle.Dispose()
        $lockHandle = $null
    }
    exit 1
}
