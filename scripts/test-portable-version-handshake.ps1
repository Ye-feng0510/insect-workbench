$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

$scriptsRoot = $PSScriptRoot
$launcherPath = Join-Path $scriptsRoot "portable\start-portable.ps1"
$updaterPath = Join-Path $scriptsRoot "portable\update-portable.ps1"
$healthContractPath = Join-Path $scriptsRoot "portable\portable-health.ps1"
$portableBuilderPath = Join-Path $scriptsRoot "build-portable.ps1"
$updaterBuilderPath = Join-Path $scriptsRoot "build-portable-updater.ps1"

function Get-ScriptAst([string]$Path) {
    $tokens = $null
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile(
        $Path,
        [ref]$tokens,
        [ref]$parseErrors
    )
    if ($parseErrors.Count -ne 0) {
        throw (
            "$Path does not parse in Windows PowerShell 5.1: " +
            ($parseErrors | ForEach-Object { $_.Message } | Out-String)
        )
    }
    return $ast
}

function Get-ScriptFunctionText($Ast, [string]$Name) {
    $functionAst = $Ast.Find(
        {
            param($node)
            $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -eq $Name
        },
        $true
    )
    if (-not $functionAst) {
        throw "Function '$Name' was not found."
    }
    return $functionAst.Extent.Text
}

$launcherAst = Get-ScriptAst $launcherPath
$updaterAst = Get-ScriptAst $updaterPath
$healthContractAst = Get-ScriptAst $healthContractPath
$portableBuilderAst = Get-ScriptAst $portableBuilderPath
$updaterBuilderAst = Get-ScriptAst $updaterBuilderPath

Invoke-Expression (Get-ScriptFunctionText $updaterAst "Test-AppHealthResponse")
Invoke-Expression (Get-ScriptFunctionText $updaterAst "Test-InstalledPayloadFile")
Invoke-Expression (Get-ScriptFunctionText $healthContractAst "Get-PortableHealthFailures")
Invoke-Expression (Get-ScriptFunctionText $healthContractAst "Test-PortableHealthResponse")

$expectedHealth = [pscustomobject]@{
    product = "insect-specimen-workbench"
    status = "ok"
    app = "test-app"
    version = "v1.2.1"
    capability = "agent_workflows_v1"
}
$matchingHealth = [pscustomobject]@{
    product = "insect-specimen-workbench"
    status = "ok"
    app = "test-app"
    version = "v1.2.1"
    capabilities = @("agent_workflows_v1")
}
$oldHealth = [pscustomobject]@{
    product = "insect-specimen-workbench"
    status = "ok"
    app = "test-app"
    version = "v1.2.0"
    capabilities = @("agent_workflows_v1")
}
$missingVersionHealth = [pscustomobject]@{
    product = "insect-specimen-workbench"
    status = "ok"
    app = "test-app"
    capabilities = @("agent_workflows_v1")
}
$missingCapabilityHealth = [pscustomobject]@{
    product = "insect-specimen-workbench"
    status = "ok"
    app = "test-app"
    version = "v1.2.1"
    capabilities = @()
}
$wrongProductHealth = [pscustomobject]@{
    product = "another-product"
    status = "ok"
    app = "test-app"
    version = "v1.2.1"
    capabilities = @("agent_workflows_v1")
}
$garbledAppHealth = [pscustomobject]@{
    product = "insect-specimen-workbench"
    status = "ok"
    app = "????"
    version = "v1.2.1"
    capabilities = @("agent_workflows_v1")
}

if (-not (Test-AppHealthResponse $matchingHealth $expectedHealth)) {
    throw "Matching version and capability health response was rejected."
}
if (Test-AppHealthResponse $oldHealth $expectedHealth) {
    throw "Old backend version was accepted."
}
if (Test-AppHealthResponse $missingVersionHealth $expectedHealth) {
    throw "Missing backend version was accepted."
}
if (Test-AppHealthResponse $missingCapabilityHealth $expectedHealth) {
    throw "Missing backend capability was accepted."
}
if (Test-AppHealthResponse $wrongProductHealth $expectedHealth) {
    throw "Mismatched backend product identity was accepted."
}
if (-not (Test-AppHealthResponse $garbledAppHealth $expectedHealth)) {
    throw "Display-name encoding affected stable product identity validation."
}

$payloadFileTestRoot = Join-Path ([IO.Path]::GetTempPath()) (
    "portable payload file test " + [Guid]::NewGuid().ToString("N")
)
try {
    New-Item -ItemType Directory -Path $payloadFileTestRoot | Out-Null
    $payloadFileTestPath = Join-Path $payloadFileTestRoot "portable-health.ps1"
    [IO.File]::WriteAllText(
        $payloadFileTestPath,
        "stable health helper",
        (New-Object Text.UTF8Encoding($false))
    )
    $payloadFileTestItem = Get-Item -LiteralPath $payloadFileTestPath
    $payloadFileTestManifest = [pscustomobject]@{
        files = @(
            [pscustomobject]@{
                path = "portable-health.ps1"
                size = [Int64]$payloadFileTestItem.Length
                sha256 = (
                    Get-FileHash -LiteralPath $payloadFileTestPath `
                        -Algorithm SHA256
                ).Hash.ToLowerInvariant()
            }
        )
    }
    if (
        -not (Test-InstalledPayloadFile `
            $payloadFileTestManifest `
            $payloadFileTestRoot `
            "portable-health.ps1")
    ) {
        throw "Matching installed health helper was rejected."
    }
    [IO.File]::AppendAllText($payloadFileTestPath, "corrupt")
    if (
        Test-InstalledPayloadFile `
            $payloadFileTestManifest `
            $payloadFileTestRoot `
            "portable-health.ps1"
    ) {
        throw "Corrupted installed health helper was accepted."
    }
    Remove-Item -LiteralPath $payloadFileTestPath -Force
    if (
        Test-InstalledPayloadFile `
            $payloadFileTestManifest `
            $payloadFileTestRoot `
            "portable-health.ps1"
    ) {
        throw "Missing installed health helper was accepted."
    }
}
finally {
    Remove-Item -LiteralPath $payloadFileTestRoot -Recurse -Force `
        -ErrorAction SilentlyContinue
}

$launcherText = $launcherAst.Extent.Text
Invoke-Expression (Get-ScriptFunctionText $launcherAst "Get-FullPath")
Invoke-Expression (
    Get-ScriptFunctionText $launcherAst "Enter-PortableLauncherLock"
)

$lockTestParent = Join-Path ([IO.Path]::GetTempPath()) (
    "portable launcher lock test " + [Guid]::NewGuid().ToString("N")
)
$lockTestRoot = Join-Path $lockTestParent "installed workbench"
$lockTestPath = Join-Path $lockTestParent ".installed workbench-update.lock"
$launcherLockTestHandle = $null

function Assert-UpdaterCannotAcquireLauncherLock([string]$Phase) {
    $contender = $null
    try {
        $contender = [IO.File]::Open(
            $lockTestPath,
            [IO.FileMode]::OpenOrCreate,
            [IO.FileAccess]::ReadWrite,
            [IO.FileShare]::None
        )
    }
    catch {
        return
    }
    finally {
        if ($contender) {
            $contender.Dispose()
        }
    }
    throw "Updater lock acquisition interleaved during launcher phase: $Phase"
}

try {
    New-Item -ItemType Directory -Path $lockTestRoot | Out-Null
    $launcherLockTestHandle = Enter-PortableLauncherLock $lockTestRoot

    Assert-UpdaterCannotAcquireLauncherLock "before health check"
    Assert-UpdaterCannotAcquireLauncherLock "while backend is starting"
    Assert-UpdaterCannotAcquireLauncherLock "after exact health establishment"

    $launcherLockTestHandle.Dispose()
    $launcherLockTestHandle = $null
    $postEstablishmentHandle = $null
    try {
        $postEstablishmentHandle = [IO.File]::Open(
            $lockTestPath,
            [IO.FileMode]::OpenOrCreate,
            [IO.FileAccess]::ReadWrite,
            [IO.FileShare]::None
        )
    }
    finally {
        if ($postEstablishmentHandle) {
            $postEstablishmentHandle.Dispose()
        }
    }
}
finally {
    if ($launcherLockTestHandle) {
        $launcherLockTestHandle.Dispose()
    }
    Remove-Item -LiteralPath $lockTestParent -Recurse -Force `
        -ErrorAction SilentlyContinue
}

$lockCheckIndex = $launcherText.IndexOf(
    '$launcherLock = Enter-PortableLauncherLock $root'
)
$healthCheckIndex = $launcherText.IndexOf(
    'if (Test-AppHealth $expectedVersion)',
    $lockCheckIndex
)
$backendStartIndex = $launcherText.IndexOf(
    '$backendProcess = Start-PortableBackend $python $root',
    $healthCheckIndex
)
$establishmentIndex = $launcherText.IndexOf(
    'Wait-PortableBackendEstablished $backendProcess $python $expectedVersion',
    $backendStartIndex
)
$establishedFlagIndex = $launcherText.IndexOf(
    '$backendEstablished = $true',
    $establishmentIndex
)
$startupReleaseIndex = $launcherText.IndexOf(
    'Exit-PortableLauncherLock',
    $establishedFlagIndex
)
if (
    $launcherText -notmatch
        '(?s)function Enter-PortableLauncherLock.+?return \[IO\.File\]::Open.+?\[IO\.FileShare\]::None' -or
    $lockCheckIndex -lt 0 -or
    $healthCheckIndex -le $lockCheckIndex -or
    $backendStartIndex -le $healthCheckIndex -or
    $establishmentIndex -le $backendStartIndex -or
    $establishedFlagIndex -le $establishmentIndex -or
    $startupReleaseIndex -le $establishedFlagIndex
) {
    throw (
        "Launcher lock is not held continuously from before health through " +
        "exact backend establishment."
    )
}
if (
    $launcherText -notmatch
        '(?s)function Wait-PortableBackendEstablished.+?\$Process\.HasExited.+?\$listener\.OwningProcess\s+-ne\s+\$Process\.Id.+?Test-SamePath\s+\$actualExecutable\s+\$ExpectedPython.+?Test-AppHealth\s+\$ExpectedVersion' -or
    $launcherText -notmatch
        '(?s)finally\s*\{.+?Stop-FailedBackendStart\s+\$backendProcess\s+\$python.+?Exit-PortableLauncherLock'
) {
    throw "Launcher does not prove exact spawned ownership and release on failure."
}
if (
    $launcherText -notmatch
        '(?s)function Start-PortableBackend.+?ConvertTo-WindowsCommandLineArgument.+?Start-Process.+?-NoNewWindow\s+-PassThru' -or
    $launcherText -notmatch
        '(?s)\$backendEstablished\s*=\s*\$true.+?Exit-PortableLauncherLock.+?\$backendProcess\.WaitForExit\(\)'
) {
    throw "Launcher does not preserve safe arguments and console process lifetime."
}
if (
    $launcherText -notmatch
        '(?s)Stop-StaleOwnedListener.+?Test-SamePath\s+\$actualExecutable\s+\$ExpectedPython.+?Stop-Process\s+-Id\s+\$listener\.OwningProcess'
) {
    throw "Launcher stale-listener stop is not guarded by exact runtime ownership."
}
if (
    $launcherText -notmatch
        '(?s)Get-ProcessExecutable\s+\$listener\.OwningProcess.+?\$ownerPath.+?throw'
) {
    throw "Launcher does not report and reject a foreign listener executable."
}
if (
    $launcherText -notmatch
        '\$releaseFile\s*=\s*Join-Path\s+\$root\s+"release\.json"' -or
    $launcherText -notmatch
        'Test-AppHealth\s+\$expectedVersion'
) {
    throw "Launcher does not derive its health version from release.json."
}

$updaterText = $updaterAst.Extent.Text
$requiredInstallText = Get-ScriptFunctionText $updaterAst "Assert-RequiredInstall"
if ($requiredInstallText -match 'portable-health\.ps1') {
    throw "Updater rejects legacy installations without the new health helper."
}
if (
    $updaterText -notmatch
        '(?s)Stop-OwnedListener.+?Test-SamePath\s+\$actualExecutable\s+\$expectedPython.+?Stop-Process\s+-Id\s+\$listener\.OwningProcess'
) {
    throw "Updater listener stop is not guarded by exact runtime ownership."
}
if (
    $updaterText -notmatch
        'Port 8000 is owned by another executable \(\$ownerPath'
) {
    throw "Updater does not report a foreign listener executable path."
}

if (
    $portableBuilderAst.Extent.Text -notmatch
        '(?m)^\s*\[string\]\$Version\s*=\s*"v1\.3\.5"\s*,?\s*$'
) {
    throw "Portable builder default version is not v1.3.5."
}
$updaterBuilderText = $updaterBuilderAst.Extent.Text
if (
    $updaterBuilderText -notmatch
        'version\s*=\s*\[string\]\$release\.version' -or
    $updaterBuilderText -notmatch
        'capability\s*=\s*"agent_workflows_v1"' -or
    $updaterBuilderText -notmatch
        'product\s*=\s*"insect-specimen-workbench"'
) {
    throw "Updater manifest does not carry the version handshake metadata."
}

Write-Host "Portable version and ownership handshake regression passed."
