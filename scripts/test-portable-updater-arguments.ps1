$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

$updaterPath = Join-Path $PSScriptRoot "portable\update-portable.ps1"
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $updaterPath,
    [ref]$tokens,
    [ref]$parseErrors
)
if ($parseErrors.Count -ne 0) {
    throw ($parseErrors | ForEach-Object { $_.Message } | Out-String)
}

$updaterText = $ast.Extent.Text
if ($updaterText -notmatch '(?m)^\$PayloadSchemaVersion\s*=\s*6\s*$') {
    throw "Updater payload schema version is not pinned to 6."
}
if ($updaterText -match 'RequireSchema4') {
    throw "Updater still contains the obsolete schema 4 validation switch."
}
if (
    $updaterText -notmatch
        '(?s)Assert-StateEquivalent\s+\$oldState\s+\$newState.+?-MinimumSchemaVersion\s+\$PayloadSchemaVersion'
) {
    throw "Updater does not validate the installed state against the payload schema version."
}
if (
    $updaterText -notmatch
        '\[string\]\$Manifest\.health\.version\s+-ne\s+\[string\]\$Manifest\.version' -or
    $updaterText -notmatch
        '\[string\]\$Manifest\.health\.capability\s+-ne\s+\$expectedCapability'
) {
    throw "Updater does not validate manifest health version and capability metadata."
}
if (
    $updaterText -notmatch
        '(?s)Test-LiveAppHealth\s+\$manifest\.health.+?Test-SamePath\s+\$listenerExecutable\s+\$installedPython'
) {
    throw "Same-version updater exit is not gated by health and runtime ownership."
}

$functionAst = $ast.Find(
    {
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq "ConvertTo-WindowsCommandLineArgument"
    },
    $true
)
if (-not $functionAst) {
    throw "Updater command-line argument encoder was not found."
}
Invoke-Expression $functionAst.Extent.Text

$copyFunctionAst = $ast.Find(
    {
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq "Copy-RegularTreeLongPath"
    },
    $true
)
if (-not $copyFunctionAst) {
    throw "Updater long-path-safe staging copy function was not found."
}
Invoke-Expression $copyFunctionAst.Extent.Text

$stateFunctionAst = $ast.Find(
    {
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq "Assert-StateEquivalent"
    },
    $true
)
if (-not $stateFunctionAst) {
    throw "Updater state validation function was not found."
}
Invoke-Expression $stateFunctionAst.Extent.Text

function New-TestState([int]$SchemaVersion) {
    $rowCounts = [pscustomobject]@{
        users = 0
        excel_templates = 0
        specimen_records = 0
        taxonomy_cache = 0
        material_batches = 0
        material_items = 0
        export_artifacts = 0
    }
    return [pscustomobject]@{
        database = [pscustomobject]@{
            present = $true
            integrity = [pscustomobject]@{ ok = $true }
            schema_version = $SchemaVersion
            app_settings_fingerprint = [pscustomobject]@{
                available = $true
                sha256 = "unchanged"
            }
            table_row_counts = $rowCounts
            completed_record_count = 0
            status_counts = [pscustomobject]@{
                specimen_records = @()
                material_items = @()
            }
        }
    }
}

$schema5Rejected = $false
try {
    Assert-StateEquivalent (New-TestState 5) (New-TestState 5) `
        -MinimumSchemaVersion 6
}
catch {
    if ($_.Exception.Message -ne "Updated database schema_version is below 6.") {
        throw
    }
    $schema5Rejected = $true
}
if (-not $schema5Rejected) {
    throw "Updater accepted schema version 5 for a schema 6 payload."
}
Assert-StateEquivalent (New-TestState 6) (New-TestState 6) `
    -MinimumSchemaVersion 6

$launchFunctionAst = $ast.Find(
    {
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq "Start-UpdatedBackend"
    },
    $true
)
if (
    -not $launchFunctionAst -or
    $launchFunctionAst.Extent.Text -notmatch
        '(?s)\$launchArguments\s*=\s*@\(.+?"--port",\s*\(\[string\]\$Port\).+?ConvertTo-WindowsCommandLineArgument.+?Start-Process.+?-ArgumentList\s+\(\[string\]::Join\(" ",\s*\[string\[\]\]\$launchArguments\)\)'
) {
    throw "Updater launch does not pass its encoded command line to Start-Process."
}

$updateText = $ast.Extent.Text
$validationLaunchIndex = $updateText.IndexOf(
    '$validationLauncher = Start-UpdatedBackend'
)
$stateAssertionIndex = $updateText.IndexOf(
    'Assert-StateEquivalent $oldState $newState',
    $validationLaunchIndex
)
$fingerprintAssertionIndex = $updateText.IndexOf(
    'Assert-FingerprintPreserved $dataFingerprint $newFingerprint',
    $stateAssertionIndex
)
$validationStopIndex = $updateText.IndexOf(
    'Stop-OwnedBackendProcess',
    $fingerprintAssertionIndex
)
$productionLaunchIndex = $updateText.IndexOf(
    '$startedLauncher = Start-UpdatedBackend',
    $validationStopIndex
)
if (
    $validationLaunchIndex -lt 0 -or
    $stateAssertionIndex -le $validationLaunchIndex -or
    $fingerprintAssertionIndex -le $stateAssertionIndex -or
    $validationStopIndex -le $fingerprintAssertionIndex -or
    $productionLaunchIndex -le $validationStopIndex
) {
    throw (
        "Production backend launch must occur only after validation-port " +
        "state and fingerprint preservation assertions and validation shutdown."
    )
}
if (
    $updateText -notmatch
        '\$validationPort\s*=\s*Get-AvailableLoopbackPort' -or
    $updateText -notmatch
        '\$validationHealthUrl\s*=\s*"http://127\.0\.0\.1:\$validationPort/api/health"' -or
    $updateText -notmatch
        '(?s)\$startedLauncher\s*=\s*Start-UpdatedBackend.+?\$embeddedPython\s+\$embeddedBackend\s+8000'
) {
    throw "Updater does not separate dynamic validation and production ports."
}

$ownershipFunctionAst = $ast.Find(
    {
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq "Assert-OwnedBackendProcess"
    },
    $true
)
$stopFunctionAst = $ast.Find(
    {
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq "Stop-OwnedBackendProcess"
    },
    $true
)
if (
    -not $ownershipFunctionAst -or
    $ownershipFunctionAst.Extent.Text -notmatch
        '(?s)\$Process\.Refresh\(\).+?\$Process\.HasExited.+?Get-ProcessExecutable\s+\$Process\.Id.+?Test-SamePath\s+\$actualExecutable\s+\$expectedPython.+?Get-PortListener\s+\$Port.+?\$listener\.OwningProcess\s+-ne\s+\$Process\.Id' -or
    -not $stopFunctionAst -or
    $stopFunctionAst.Extent.Text -notmatch
        '(?s)Assert-OwnedBackendProcess\s+\$Process\s+\$Root\s+\$Port.+?Stop-Process\s+-Id\s+\$processId\s+-Force'
) {
    throw "Updater rollback process stops are not guarded by exact handle, executable, and port ownership."
}
if (
    $stopFunctionAst.Extent.Text -match 'RequireListener' -or
    $updateText -notmatch
        '(?s)Assert-OwnedBackendProcess\s+`\s*\r?\n\s*\$validationLauncher\s+\$InstallRoot\s+\$validationPort\s+-RequireListener' -or
    $updateText -notmatch
        '(?s)Assert-OwnedBackendProcess\s+`\s*\r?\n\s*\$startedLauncher\s+\$InstallRoot\s+8000\s+-RequireListener'
) {
    throw "Updater does not safely distinguish pre-listen cleanup from healthy listener validation."
}
if (
    $updateText -match 'Stop-OwnedPortableProcesses' -or
    $updateText -match
        'Get-CimInstance\s+Win32_Process\s+-ErrorAction' -or
    $updateText -match
        '(?s)if\s*\(\$oldMoved\).+?Stop-OwnedListener\s+\$InstallRoot'
) {
    throw "Updater rollback still enumerates or broadly kills portable runtime processes."
}
if (
    $updateText -notmatch
        '(?s)if\s*\(\$oldMoved\).+?if\s*\(\$validationLauncher\).+?Stop-OwnedBackendProcess\s+`\s*\r?\n\s*\$validationLauncher\s+\$InstallRoot\s+\$validationPort.+?if\s*\(\$startedLauncher\).+?Stop-OwnedBackendProcess\s+`\s*\r?\n\s*\$startedLauncher\s+\$InstallRoot\s+8000.+?Move-WithRetry\s+\$InstallRoot\s+\$failedRoot'
) {
    throw "Updater rollback does not stop only its exact validation and production launch handles."
}

$testRoot = Join-Path ([IO.Path]::GetTempPath()) (
    "portable updater argument test " + [Guid]::NewGuid().ToString("N")
)
$probePath = Join-Path $testRoot "argument probe.ps1"
$resultPath = Join-Path $testRoot "captured arguments.json"
$backendPath = Join-Path $testRoot "installed workbench\backend"
$pythonCommand = Get-Command python.exe -ErrorAction Stop
$cleanupScriptPath = [IO.Path]::GetTempFileName()
$testEncoding = New-Object Text.UTF8Encoding($false)

try {
    New-Item -ItemType Directory -Path $testRoot | Out-Null
    [IO.File]::WriteAllText(
        $probePath,
        @'
$OutputPath = $args[0]
$Captured = @($args | Select-Object -Skip 1)
[IO.File]::WriteAllText(
    $OutputPath,
    ($Captured | ConvertTo-Json -Compress),
    (New-Object Text.UTF8Encoding($false))
)
'@,
        (New-Object Text.UTF8Encoding($false))
    )

    $arguments = @(
        "-NoLogo",
        "-NoProfile",
        "-File",
        $probePath,
        $resultPath,
        "-I",
        "-B",
        "-m",
        "uvicorn",
        "app.main:app",
        "--host",
        "127.0.0.1",
        "--port",
        "8000",
        "--app-dir",
        $backendPath
    ) | ForEach-Object {
        ConvertTo-WindowsCommandLineArgument ([string]$_)
    }
    $process = Start-Process -FilePath "powershell.exe" `
        -ArgumentList ([string]::Join(" ", [string[]]$arguments)) `
        -PassThru -Wait
    if ($process.ExitCode -ne 0) {
        throw "Argument probe exited with code $($process.ExitCode)."
    }

    $captured = @(
        ConvertFrom-Json ([IO.File]::ReadAllText($resultPath)) |
            ForEach-Object { $_ }
    )
    $expected = @(
        "-I",
        "-B",
        "-m",
        "uvicorn",
        "app.main:app",
        "--host",
        "127.0.0.1",
        "--port",
        "8000",
        "--app-dir",
        $backendPath
    )
    if ($captured.Count -ne $expected.Count) {
        throw "Expected $($expected.Count) arguments, captured $($captured.Count)."
    }
    for ($index = 0; $index -lt $expected.Count; $index++) {
        if ($captured[$index] -cne $expected[$index]) {
            throw (
                "Argument {0} differed. Expected <{1}>, captured <{2}>." -f
                $index,
                $expected[$index],
                $captured[$index]
            )
        }
    }

    $longSource = Join-Path $testRoot "long path source"
    $longDestination = Join-Path $testRoot "long path destination"
    $segments = @(
        "first nested directory with spaces 0123456789",
        "second nested directory with spaces 0123456789",
        "third nested directory with spaces 0123456789",
        "fourth nested directory with spaces 0123456789",
        "fifth nested directory with spaces 0123456789",
        "sixth nested directory with spaces 0123456789"
    )
    $relativeLongFile = [IO.Path]::Combine(
        [string[]]($segments + @("representative payload file.txt"))
    )
    $sourceLongFile = Join-Path $longSource $relativeLongFile
    $destinationLongFile = Join-Path $longDestination $relativeLongFile
    if ($destinationLongFile.Length -le 260) {
        throw "Long-path regression fixture did not exceed 260 characters."
    }

    $expectedLongContent = "portable updater long path content with spaces"
    $createLongFixturePath = Join-Path $testRoot "create long fixture.py"
    $createLongFixture = @'
import os
import sys

def extended_path(path):
    absolute = os.path.abspath(path)
    if os.name != "nt" or absolute.startswith("\\\\?\\"):
        return absolute
    if absolute.startswith("\\\\"):
        return "\\\\?\\UNC\\" + absolute[2:]
    return "\\\\?\\" + absolute

path = extended_path(sys.argv[1])
os.makedirs(os.path.dirname(path))
with open(path, "wb") as stream:
    stream.write(sys.argv[2].encode("utf-8"))
'@
    [IO.File]::WriteAllText(
        $createLongFixturePath,
        $createLongFixture,
        $testEncoding
    )
    & $pythonCommand.Source `
        -I -B $createLongFixturePath $sourceLongFile $expectedLongContent
    if ($LASTEXITCODE -ne 0) {
        throw "Could not create the long-path staging regression fixture."
    }

    Copy-RegularTreeLongPath `
        $pythonCommand.Source $longSource $longDestination

    $verifyLongFixturePath = Join-Path $testRoot "verify long fixture.py"
    $verifyLongFixture = @'
import os
import sys

def extended_path(path):
    absolute = os.path.abspath(path)
    if os.name != "nt" or absolute.startswith("\\\\?\\"):
        return absolute
    if absolute.startswith("\\\\"):
        return "\\\\?\\UNC\\" + absolute[2:]
    return "\\\\?\\" + absolute

path = extended_path(sys.argv[1])
root_path = extended_path(sys.argv[3])
expected = sys.argv[2].encode("utf-8")
with open(path, "rb") as stream:
    actual = stream.read()
if actual != expected:
    raise RuntimeError("staged long-path file contents differed")
files = []
for root, directories, names in os.walk(root_path):
    files.extend(os.path.join(root, name) for name in names)
if files != [path]:
    raise RuntimeError("staged long-path tree did not contain exactly one file")
'@
    [IO.File]::WriteAllText(
        $verifyLongFixturePath,
        $verifyLongFixture,
        $testEncoding
    )
    & $pythonCommand.Source `
        -I -B $verifyLongFixturePath `
        $destinationLongFile $expectedLongContent $longDestination
    if ($LASTEXITCODE -ne 0) {
        throw "Long-path-safe staging copy content verification failed."
    }

    Write-Host "Portable updater spaced-path argument regression passed."
    Write-Host "Portable updater long-path staging regression passed."
}
finally {
    $cleanupLongFixture = @'
import os
import shutil
import sys

path = os.path.abspath(sys.argv[1])
if os.name == "nt" and not path.startswith("\\\\?\\"):
    if path.startswith("\\\\"):
        path = "\\\\?\\UNC\\" + path[2:]
    else:
        path = "\\\\?\\" + path
shutil.rmtree(path, ignore_errors=True)
'@
    [IO.File]::WriteAllText(
        $cleanupScriptPath,
        $cleanupLongFixture,
        $testEncoding
    )
    & $pythonCommand.Source -I -B $cleanupScriptPath $testRoot
    Remove-Item -LiteralPath $cleanupScriptPath -Force `
        -ErrorAction SilentlyContinue
}
