# ─────────────────────────────────────────────────────────────────────────────
# Digimart smoke tests — Windows PowerShell 5.1+ / PowerShell 7
#
# 1. Proves this machine's SHA-512 matches Digimart's worked example.
# 2. Calls the REST APIs you have configured, with your credentials.
# 3. Optionally prints a freshly signed authorize URL to open in a browser.
#
# Usage:
#   .\scripts\smoke-test.ps1
#   .\scripts\smoke-test.ps1 -PrintUrl
#   $env:TEST_SUBSCRIBER_ID = '<masked id>'; .\scripts\smoke-test.ps1 -WithUnsubscribe   # REAL effect
#
# Reads .env from the current directory if present. Run it from the server that
# will call Digimart. Never paste credentials into this file.
# ─────────────────────────────────────────────────────────────────────────────
param(
    [switch]$PrintUrl,
    [switch]$WithUnsubscribe
)

$ErrorActionPreference = 'Stop'

if (Test-Path .env) {
    Get-Content .env | Where-Object { $_ -match '^\s*[A-Z_]+=' } | ForEach-Object {
        $name, $value = $_ -split '=', 2
        if (-not [Environment]::GetEnvironmentVariable($name.Trim())) {
            [Environment]::SetEnvironmentVariable($name.Trim(), $value.Trim(), 'Process')
        }
    }
}

$script:Pass = 0; $script:Fail = 0; $script:Skip = 0

function Get-Sha512Hex([string]$text) {
    $sha = [System.Security.Cryptography.SHA512]::Create()
    try {
        $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($text))
        return -join ($bytes | ForEach-Object { $_.ToString('x2') })
    } finally { $sha.Dispose() }
}

function Skip([string]$name, [string]$why) {
    Write-Host ('{0,-34}' -f $name) -NoNewline; Write-Host $why -ForegroundColor DarkGray; $script:Skip++
}

function Invoke-Rest([string]$name, [string]$url, [hashtable]$body, [string[]]$ok) {
    Write-Host ('{0,-34}' -f $name) -NoNewline
    try {
        $response = Invoke-RestMethod -Method Post -Uri $url -ContentType 'application/json;charset=utf-8' `
            -Body ($body | ConvertTo-Json -Depth 5 -Compress) -TimeoutSec 20
    } catch {
        Write-Host "NO RESPONSE  ($($_.Exception.Message))" -ForegroundColor Red; $script:Fail++; return
    }
    if ($ok -contains $response.statusCode) {
        Write-Host $response.statusCode -ForegroundColor Green; $script:Pass++
    } else {
        Write-Host "$($response.statusCode)  $($response.statusDetail)" -ForegroundColor Red
        Write-Host '  REST codes other than S1000 have no published meaning - statusDetail is the explanation.' -ForegroundColor DarkGray
        $script:Fail++
    }
}

Write-Host "`n── Hashing ─────────────────────────────────────────────"
Write-Host ('{0,-34}' -f 'SHA-512 of the worked example') -NoNewline
$expected = '3badf638ceca499000fd07b899e5fc0cec348d9762886b8430104291126683892845a208caef8e99b53432571e46c5f04162a1a25646443f7935239ea0901b38'
if ((Get-Sha512Hex 'myApiKey123|2024-08-08T12:00:00Z|mySecretKey456|50') -eq $expected) {
    Write-Host 'matches' -ForegroundColor Green; $script:Pass++
} else {
    Write-Host 'MISMATCH' -ForegroundColor Red; $script:Fail++
}

Write-Host "`n── REST (api.digimart.store) ───────────────────────────"
$appId = $env:DIGIMART_APP_ID; $password = $env:DIGIMART_PASSWORD
$testId = if ($env:TEST_SUBSCRIBER_ID) { $env:TEST_SUBSCRIBER_ID -replace '^tel:\s*', '' } else { $null }

if (-not $appId -or -not $password) {
    Skip 'REST calls' 'DIGIMART_APP_ID / DIGIMART_PASSWORD not set'
} else {
    if ($env:DIGIMART_GET_SUBSCRIBERS_URL) {
        Invoke-Rest 'Subscriber List (page 1)' $env:DIGIMART_GET_SUBSCRIBERS_URL `
            @{ applicationId = $appId; password = $password; version = '2.0'; requestPage = 1 } @('S1000', 'S1001')
    } else { Skip 'Subscriber List' 'DIGIMART_GET_SUBSCRIBERS_URL not set' }

    if ($env:DIGIMART_CHARGING_INFO_URL -and $testId) {
        Invoke-Rest 'Subscriber Charging Info' $env:DIGIMART_CHARGING_INFO_URL `
            @{ applicationId = $appId; password = $password; subscriberId = @("tel:$testId") } @('S1000')
    } else { Skip 'Subscriber Charging Info' 'needs DIGIMART_CHARGING_INFO_URL and TEST_SUBSCRIBER_ID' }

    if ($WithUnsubscribe) {
        if ($env:DIGIMART_UNREGISTRATION_URL -and $testId) {
            Write-Host "  Unsubscribing $($testId.Substring(0, [Math]::Min(6, $testId.Length)))... - this is real." -ForegroundColor Yellow
            Invoke-Rest 'User Unsubscription' $env:DIGIMART_UNREGISTRATION_URL `
                @{ applicationId = $appId; password = $password; subscriberId = "tel:$testId"; action = '0' } @('S1000')
        } else { Skip 'User Unsubscription' 'needs DIGIMART_UNREGISTRATION_URL and TEST_SUBSCRIBER_ID' }
    } else { Skip 'User Unsubscription' 'pass -WithUnsubscribe to run it' }
}

if ($PrintUrl) {
    Write-Host "`n── Signed URLs to open in a browser ────────────────────"
    $key = $env:DIGIMART_API_KEY; $secret = $env:DIGIMART_API_SECRET; $redirect = $env:DIGIMART_REDIRECT_URL
    if (-not $key -or -not $secret -or -not $redirect) {
        Skip 'Authorize URLs' 'DIGIMART_API_KEY / DIGIMART_API_SECRET / DIGIMART_REDIRECT_URL not set'
    } else {
        $rt = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
        $newId = { '{0}{1:D8}' -f (Get-Random -Minimum 1000000 -Maximum 10000000), (Get-Random -Minimum 0 -Maximum 100000000) }
        $enc = { param($v) [Uri]::EscapeDataString($v) }
        if ($env:DIGIMART_SUBSCRIPTION_AUTHORIZE_URL) {
            $sig = Get-Sha512Hex "$key|$rt|$secret"
            Write-Host 'Subscription:'
            Write-Host "  $($env:DIGIMART_SUBSCRIPTION_AUTHORIZE_URL)?apiKey=$key&requestId=$(& $newId)&requestTime=$(& $enc $rt)&signature=$sig&redirectUrl=$(& $enc $redirect)"
        }
        if ($env:DIGIMART_CAAS_AUTHORIZE_URL) {
            $amount = if ($env:TEST_AMOUNT) { $env:TEST_AMOUNT } else { '1' }
            $sig = Get-Sha512Hex "$key|$rt|$secret|$amount"
            Write-Host "One-time charge of $amount BDT (REAL money if completed):"
            Write-Host "  $($env:DIGIMART_CAAS_AUTHORIZE_URL)?apiKey=$key&requestId=$(& $newId)&requestTime=$(& $enc $rt)&signature=$sig&redirectUrl=$(& $enc $redirect)&amount=$amount"
        }
        Write-Host '  Open within a minute or two - a stale requestTime is rejected (E1004).' -ForegroundColor DarkGray
    }
}

Write-Host "`n────────────────────────────────────────────────────────"
Write-Host "  passed $script:Pass   failed $script:Fail   skipped $script:Skip`n"
if ($script:Fail -gt 0) { exit 1 }
