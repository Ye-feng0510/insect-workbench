param(
    [string]$InstallRoot = "",
    [switch]$NonInteractive,
    [switch]$NoBrowser,
    [ValidateRange(10, 600)]
    [int]$HealthTimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

$updaterRoot = $PSScriptRoot
$manifestPath = Join-Path $updaterRoot "manifest.json"
$payloadRoot = Join-Path $updaterRoot "payload"
$inspectorPath = Join-Path $updaterRoot "inspect-portable-state.py"
$expectedApp = "昆虫标本图片识别与Excel录入工作台"
$healthUrl = "http://127.0.0.1:8000/api/health"
$utf8 = New-Object System.Text.UTF8Encoding($false)
$journalPath = $null
$logPath = $null
$stageRoot = $null
$backupRoot = $null
$failedRoot = $null
$oldMoved = $false
$newInstalled = $false
$startedLauncher = $null
$lockHandle = $null

function Get-FullPath([string]$Path) {
    return [IO.Path]::GetFullPath($Path).TrimEnd(
        [IO.Path]::DirectorySeparatorChar,
        [IO.Path]::AltDirectorySeparatorChar
    )
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

function Get-PortListener {
    return Get-NetTCPConnection -LocalPort 8000 -State Listen `
        -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Get-ProcessExecutable([int]$ProcessId) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" `
        -ErrorAction SilentlyContinue
    if (-not $process -or -not $process.ExecutablePath) {
        return $null
    }
    return Get-FullPath ([string]$process.ExecutablePath)
}

function Stop-OwnedListener([string]$Root, [switch]$Required) {
    $listener = Get-PortListener
    if (-not $listener) {
        return
    }
    $expectedPython = Join-Path $Root "runtime\python\python.exe"
    $actualExecutable = Get-ProcessExecutable $listener.OwningProcess
    if (-not $actualExecutable -or -not (Test-SamePath $actualExecutable $expectedPython)) {
        if ($Required) {
            throw "Port 8000 is owned by another executable; update aborted without changing files."
        }
        return
    }
    Write-Log "Stopping portable application process $($listener.OwningProcess)..."
    Stop-Process -Id $listener.OwningProcess -ErrorAction Stop
    try {
        Wait-Process -Id $listener.OwningProcess -Timeout 10 `
            -ErrorAction SilentlyContinue
    }
    catch {
    }
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        if (-not (Get-PortListener)) {
            return
        }
        Start-Sleep -Milliseconds 250
    }
    throw "Portable application did not release port 8000."
}

function Stop-OwnedPortableProcesses([string]$Root) {
    $expectedPython = Join-Path $Root "runtime\python\python.exe"
    $processes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
    foreach ($process in @($processes)) {
        if (-not $process.ExecutablePath) {
            continue
        }
        try {
            if (Test-SamePath ([string]$process.ExecutablePath) $expectedPython) {
                Stop-Process -Id $process.ProcessId -Force `
                    -ErrorAction SilentlyContinue
            }
        }
        catch {
        }
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
        [string]$Manifest.health.status -ne "ok"
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

function Assert-StateEquivalent($Before, $After, [switch]$RequireSchema4) {
    $beforeDb = $Before.database
    $afterDb = $After.database
    if (-not $afterDb.present -or -not $afterDb.integrity.ok) {
        throw "Updated database is missing or failed integrity_check."
    }
    if ($RequireSchema4 -and [int]$afterDb.schema_version -lt 4) {
        throw "Updated database schema_version is below 4."
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

function Wait-AppHealth {
    $deadline = (Get-Date).AddSeconds($HealthTimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $client = New-Object System.Net.WebClient
            $client.Encoding = [Text.Encoding]::UTF8
            $json = $client.DownloadString($healthUrl)
            $response = $json | ConvertFrom-Json
            if ($response.status -eq "ok" -and $response.app -eq $expectedApp) {
                return
            }
        }
        catch {
        }
        Start-Sleep -Milliseconds 500
    }
    throw "Updated application did not pass the exact health check within $HealthTimeoutSeconds seconds."
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
            Write-Host "The portable application is already version $($manifest.version)." `
                -ForegroundColor Green
            $lockHandle.Dispose()
            $lockHandle = $null
            exit 0
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

    New-Item -ItemType Directory -Path $stageRoot | Out-Null
    Get-ChildItem -LiteralPath $payloadRoot -Force |
        ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination $stageRoot `
                -Recurse -Force
        }
    Copy-Item -LiteralPath (Join-Path $InstallRoot ".env") `
        -Destination (Join-Path $stageRoot ".env") -Force
    Copy-Item -LiteralPath (Join-Path $InstallRoot "data") `
        -Destination $stageRoot -Recurse -Force
    Assert-RegularTree $stageRoot "Staged application"
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
    if ($NoBrowser) {
        $env:INSECT_PORTABLE_NO_BROWSER = "1"
    }
    try {
        $startedLauncher = Start-Process -FilePath $embeddedPython `
            -ArgumentList @(
                "-I", "-B",
                "-m", "uvicorn", "app.main:app",
                "--host", "127.0.0.1", "--port", "8000",
                "--app-dir", $embeddedBackend
            ) `
            -WorkingDirectory $InstallRoot -PassThru `
            -WindowStyle Hidden
    }
    finally {
        if ($NoBrowser) {
            Remove-Item Env:INSECT_PORTABLE_NO_BROWSER -ErrorAction SilentlyContinue
        }
    }
    Wait-AppHealth
    $listener = Get-PortListener
    $newPython = Join-Path $InstallRoot "runtime\python\python.exe"
    if (
        -not $listener -or
        -not (Test-SamePath (Get-ProcessExecutable $listener.OwningProcess) $newPython)
    ) {
        throw "Healthy service is not owned by the updated portable runtime."
    }
    $newState = Invoke-Inspector $InstallRoot $newStatePath
    Assert-StateEquivalent $oldState $newState -RequireSchema4
    if (
        $envHash -ne
        (Get-FileHash -LiteralPath (Join-Path $InstallRoot ".env") -Algorithm SHA256).Hash
    ) {
        throw ".env changed during update."
    }
    $newFingerprint = Get-DataFingerprint $InstallRoot
    Assert-FingerprintPreserved $dataFingerprint $newFingerprint

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
                try { Stop-OwnedListener $InstallRoot } catch {}
                if ($startedLauncher -and -not $startedLauncher.HasExited) {
                    Stop-Process -Id $startedLauncher.Id -Force `
                        -ErrorAction SilentlyContinue
                }
                Stop-OwnedPortableProcesses $InstallRoot
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
