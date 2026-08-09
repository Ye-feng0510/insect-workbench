$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$python = Join-Path $root "runtime\python\python.exe"
$envFile = Join-Path $root ".env"
$releaseFile = Join-Path $root "release.json"
$url = "http://127.0.0.1:8000"
$healthUrl = "$url/api/health"
$healthContractFile = Join-Path $root "portable-health.ps1"
$expectedProduct = "insect-specimen-workbench"
$expectedApp = "昆虫标本图片识别与Excel录入工作台"
$expectedCapability = "agent_workflows_v1"
$openBrowser = $env:INSECT_PORTABLE_NO_BROWSER -ne "1"
$launcherLock = $null
$backendProcess = $null
$backendEstablished = $false

if (-not (Test-Path -LiteralPath $healthContractFile -PathType Leaf)) {
    throw "便携版健康检查组件缺失，请重新下载并完整解压便携版。"
}
. $healthContractFile

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

function Enter-PortableLauncherLock([string]$Root) {
    $installRoot = Get-FullPath $Root
    $parent = Split-Path -Parent $installRoot
    $leaf = Split-Path -Leaf $installRoot
    $lockPath = Join-Path $parent ".$leaf-update.lock"
    try {
        return [IO.File]::Open(
            $lockPath,
            [IO.FileMode]::OpenOrCreate,
            [IO.FileAccess]::ReadWrite,
            [IO.FileShare]::None
        )
    }
    catch {
        throw "便携版正在更新，请等待更新完成后再启动。"
    }
}

function Exit-PortableLauncherLock {
    if ($script:launcherLock) {
        $script:launcherLock.Dispose()
        $script:launcherLock = $null
    }
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

function Get-AppHealthCheck([string]$ExpectedVersion) {
    $expectedHealth = [pscustomobject]@{
        product = $expectedProduct
        app = $expectedApp
        version = $ExpectedVersion
        capability = $expectedCapability
    }
    try {
        $response = Get-PortableHealthResponse $healthUrl
        $failures = @(Get-PortableHealthFailures $response $expectedHealth)
        return [pscustomobject]@{
            Passed = $failures.Count -eq 0
            Failures = $failures
        }
    }
    catch {
        return [pscustomobject]@{
            Passed = $false
            Failures = @("请求或 UTF-8 JSON 解析失败: $($_.Exception.Message)")
        }
    }
}

function Test-AppHealth([string]$ExpectedVersion) {
    return (Get-AppHealthCheck $ExpectedVersion).Passed
}

function Get-HealthFailureText($HealthCheck) {
    if (-not $HealthCheck.Failures -or $HealthCheck.Failures.Count -eq 0) {
        return "未知原因"
    }
    return [string]::Join(", ", [string[]]$HealthCheck.Failures)
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

function Stop-StaleOwnedListener([string]$ExpectedPython) {
    $listener = Get-PortListener
    if (-not $listener) {
        return
    }

    $actualExecutable = Get-ProcessExecutable $listener.OwningProcess
    if (
        -not $actualExecutable -or
        -not (Test-SamePath $actualExecutable $ExpectedPython)
    ) {
        $ownerPath = if ($actualExecutable) {
            $actualExecutable
        }
        else {
            "<unavailable>"
        }
        throw (
            "端口 8000 上的服务版本不匹配，且由其他程序占用：" +
            "$ownerPath（PID $($listener.OwningProcess)）。为保护数据，启动已中止。"
        )
    }

    Write-Host "正在停止此便携版遗留的旧后台进程..." -ForegroundColor Yellow
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
    throw "旧后台进程未能释放端口 8000，请重启电脑后再试。"
}

function Start-PortableBackend([string]$Python, [string]$Root) {
    $arguments = @(
        "-I", "-B",
        "-m", "uvicorn", "app.main:app",
        "--host", "127.0.0.1",
        "--port", "8000",
        "--app-dir", "backend"
    ) | ForEach-Object {
        ConvertTo-WindowsCommandLineArgument ([string]$_)
    }
    return Start-Process -FilePath $Python `
        -ArgumentList ([string]::Join(" ", [string[]]$arguments)) `
        -WorkingDirectory $Root -NoNewWindow -PassThru
}

function Wait-PortableBackendEstablished(
    $Process,
    [string]$ExpectedPython,
    [string]$ExpectedVersion
) {
    $lastHealthFailure = "尚未收到健康响应"
    for ($attempt = 0; $attempt -lt 120; $attempt++) {
        $Process.Refresh()
        if ($Process.HasExited) {
            throw (
                "内置后台进程在启动完成前退出（退出代码 " +
                "$($Process.ExitCode)）。"
            )
        }

        $listener = Get-PortListener
        if ($listener) {
            if ($listener.OwningProcess -ne $Process.Id) {
                throw (
                    "端口 8000 被其他进程占用（PID " +
                    "$($listener.OwningProcess)），启动已中止。"
                )
            }
            $actualExecutable = Get-ProcessExecutable $Process.Id
            $healthCheck = Get-AppHealthCheck $ExpectedVersion
            if (
                $actualExecutable -and
                (Test-SamePath $actualExecutable $ExpectedPython) -and
                $healthCheck.Passed
            ) {
                return
            }
            $lastHealthFailure = Get-HealthFailureText $healthCheck
        }
        Start-Sleep -Milliseconds 500
    }
    throw (
        "内置后台未能在 60 秒内通过身份与健康检查。最近一次健康检查失败原因：" +
        $lastHealthFailure
    )
}

function Stop-FailedBackendStart($Process, [string]$ExpectedPython) {
    if (-not $Process) {
        return
    }
    $Process.Refresh()
    if ($Process.HasExited) {
        return
    }
    $actualExecutable = Get-ProcessExecutable $Process.Id
    if (
        -not $actualExecutable -or
        -not (Test-SamePath $actualExecutable $ExpectedPython)
    ) {
        return
    }
    Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
    try {
        Wait-Process -Id $Process.Id -Timeout 10 -ErrorAction SilentlyContinue
    }
    catch {
    }
}

function ConvertTo-DotenvValue([string]$value) {
    if ($value.Contains("`r") -or $value.Contains("`n")) {
        throw "账号和密码不能包含换行符。"
    }
    return '"' + $value.Replace("\", "\\").Replace('"', '\"') + '"'
}

function New-InitialEnvironment {
    Write-Host "首次启动需要创建管理员账号。" -ForegroundColor Cyan

    do {
        $username = (Read-Host "管理员用户名").Trim()
    } while (-not $username)

    do {
        $securePassword = Read-Host "管理员密码（至少 12 位）" -AsSecureString
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR(
            $securePassword
        )
        try {
            $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
                $pointer
            )
        }
        finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        }
        if ($password.Length -lt 12) {
            Write-Host "密码至少需要 12 位，请重新输入。" -ForegroundColor Yellow
        }
    } while ($password.Length -lt 12)

    $lines = @(
        "BACKEND_HOST=127.0.0.1"
        "BACKEND_PORT=8000"
        "INSECT_BOOTSTRAP_ADMIN_USERNAME=$(ConvertTo-DotenvValue $username)"
        "INSECT_BOOTSTRAP_ADMIN_PASSWORD=$(ConvertTo-DotenvValue $password)"
        "AUTH_COOKIE_SECURE=false"
        "AUTH_SESSION_HOURS=24"
        "DEFAULT_USER_QUOTA=100"
        "MODEL_TIMEOUT_SECONDS=120"
        "MODEL_MAX_RETRIES=2"
        "IMAGE_MAX_LONG_EDGE=3000"
        "IMAGE_JPEG_QUALITY=90"
        'CORS_ORIGINS=["http://localhost:5173","http://127.0.0.1:5173"]'
    )
    $temporary = "$envFile.tmp-$PID"
    $encoding = New-Object System.Text.UTF8Encoding($false)
    try {
        [IO.File]::WriteAllLines($temporary, $lines, $encoding)
        Move-Item -LiteralPath $temporary -Destination $envFile
    }
    finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        $password = $null
    }
}

try {
    $launcherLock = Enter-PortableLauncherLock $root

    if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
        throw "内置 Python 运行环境缺失，请重新下载并完整解压便携版。"
    }
    if (-not (Test-Path -LiteralPath $releaseFile -PathType Leaf)) {
        throw "release.json 缺失，请重新下载并完整解压便携版。"
    }
    try {
        $release = Get-Content -LiteralPath $releaseFile -Raw -Encoding UTF8 |
            ConvertFrom-Json
    }
    catch {
        throw "release.json 无法读取，请重新下载并完整解压便携版。"
    }
    if (
        [string]$release.product -ne "insect-specimen-workbench" -or
        -not [string]$release.version -or
        [string]$release.arch -ne "windows-x64"
    ) {
        throw "release.json 内容无效，请重新下载并完整解压便携版。"
    }
    $expectedVersion = [string]$release.version

    $writeProbe = Join-Path $root ".portable-write-test-$PID"
    try {
        [IO.File]::WriteAllText($writeProbe, "ok")
    }
    catch {
        throw "当前目录不可写，请把便携版解压到桌面或其他可写目录。"
    }
    finally {
        Remove-Item -LiteralPath $writeProbe -Force -ErrorAction SilentlyContinue
    }

    if (Test-AppHealth $expectedVersion) {
        $healthyListener = Get-PortListener
        if (-not $healthyListener) {
            throw "健康服务未绑定端口 8000，启动已中止。"
        }
        $healthyExecutable = Get-ProcessExecutable $healthyListener.OwningProcess
        if (
            -not $healthyExecutable -or
            -not (Test-SamePath $healthyExecutable $python)
        ) {
            $ownerPath = if ($healthyExecutable) {
                $healthyExecutable
            }
            else {
                "<unavailable>"
            }
            throw (
                "端口 8000 上的服务由其他程序提供：" +
                "$ownerPath（PID $($healthyListener.OwningProcess)）。启动已中止。"
            )
        }
        Write-Host "昆虫标本工作台已经在运行。"
        Exit-PortableLauncherLock
        if ($openBrowser) {
            Start-Process $url
        }
        exit 0
    }

    Stop-StaleOwnedListener $python

    if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
        New-InitialEnvironment
    }

    Remove-Item Env:PYTHONHOME -ErrorAction SilentlyContinue
    Remove-Item Env:PYTHONPATH -ErrorAction SilentlyContinue
    $env:PYTHONDONTWRITEBYTECODE = "1"
    $env:PYTHONNOUSERSITE = "1"

    Write-Host "正在启动昆虫标本工作台，请保持此窗口开启。" -ForegroundColor Cyan
    $backendProcess = Start-PortableBackend $python $root
    Wait-PortableBackendEstablished $backendProcess $python $expectedVersion
    $backendEstablished = $true
    Exit-PortableLauncherLock

    if ($openBrowser) {
        Start-Process $url
    }

    $backendProcess.WaitForExit()
    $exitCode = $backendProcess.ExitCode
}
finally {
    if (-not $backendEstablished) {
        Stop-FailedBackendStart $backendProcess $python
    }
    Exit-PortableLauncherLock
}

exit $exitCode
