function Get-PortableHealthResponse([string]$Url) {
    $client = New-Object System.Net.WebClient
    $client.Encoding = [Text.Encoding]::UTF8
    try {
        return $client.DownloadString($Url) | ConvertFrom-Json
    }
    finally {
        $client.Dispose()
    }
}

function Get-PortableHealthFailures($Response, $ExpectedHealth) {
    $failures = @()
    $properties = $Response.PSObject.Properties
    $status = $properties["status"]
    $product = $properties["product"]
    $version = $properties["version"]
    $capability = $properties["capability"]
    $capabilities = $properties["capabilities"]
    $hasCapability = (
        (
            $capability -and
            [string]$capability.Value -eq [string]$ExpectedHealth.capability
        ) -or
        (
            $capabilities -and
            @($capabilities.Value) -contains [string]$ExpectedHealth.capability
        )
    )

    if (-not $status -or [string]$status.Value -ne "ok") {
        $actualStatus = if ($status) { [string]$status.Value } else { "<missing>" }
        $failures += "status 期望 ok，实际 $actualStatus"
    }
    if (
        -not $product -or
        [string]$product.Value -ne [string]$ExpectedHealth.product
    ) {
        $actualProduct = if ($product) {
            [string]$product.Value
        }
        else {
            "<missing>"
        }
        $failures += (
            "product 期望 $([string]$ExpectedHealth.product)，实际 $actualProduct"
        )
    }
    if (
        -not $version -or
        [string]$version.Value -ne [string]$ExpectedHealth.version
    ) {
        $actualVersion = if ($version) {
            [string]$version.Value
        }
        else {
            "<missing>"
        }
        $failures += (
            "version 期望 $([string]$ExpectedHealth.version)，实际 $actualVersion"
        )
    }
    if (-not $hasCapability) {
        $failures += (
            "缺少能力 $([string]$ExpectedHealth.capability)"
        )
    }
    return $failures
}

function Test-PortableHealthResponse($Response, $ExpectedHealth) {
    return @(Get-PortableHealthFailures $Response $ExpectedHealth).Count -eq 0
}
