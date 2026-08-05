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

$launchPattern = @'
(?s)\$launchArguments\s*=\s*@\(.+?"--app-dir",\s*\$embeddedBackend.+?ConvertTo-WindowsCommandLineArgument.+?\$startedLauncher\s*=\s*Start-Process.+?-ArgumentList\s+\(\[string\]::Join\(" ",\s*\[string\[\]\]\$launchArguments\)\)
'@
if ($ast.Extent.Text -notmatch $launchPattern.Trim()) {
    throw "Updater launch does not pass its encoded command line to Start-Process."
}

$testRoot = Join-Path ([IO.Path]::GetTempPath()) (
    "portable updater argument test " + [Guid]::NewGuid().ToString("N")
)
$probePath = Join-Path $testRoot "argument probe.ps1"
$resultPath = Join-Path $testRoot "captured arguments.json"
$backendPath = Join-Path $testRoot "installed workbench\backend"

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

    Write-Host "Portable updater spaced-path argument regression passed."
}
finally {
    Remove-Item -LiteralPath $testRoot -Recurse -Force `
        -ErrorAction SilentlyContinue
}
