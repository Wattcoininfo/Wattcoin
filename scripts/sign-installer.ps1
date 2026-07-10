<#
.SYNOPSIS
    Signs a Wattcoin installer .exe using the dev certificate created by
    make-dev-cert.ps1.

.DESCRIPTION
    Locates the most recently built installer in Releases\ (highest version
    number) and signs it with signtool.exe.  Optionally targets a specific file
    via -InstallerPath.

.PARAMETER PfxPassword
    Password for certs\sign.pfx.  Must match what was supplied when running
    make-dev-cert.ps1.  Defaults to "WattcoinDev".

.PARAMETER InstallerPath
    Full path to a specific installer .exe to sign.  If omitted, the script
    picks the latest "Wattcoin Miner Setup *.exe" in the Releases\ folder.

.PARAMETER TimestampUrl
    RFC 3161 timestamp server URL.
    Defaults to http://timestamp.digicert.com (free, no key required).

.EXAMPLE
    .\scripts\sign-installer.ps1
    .\scripts\sign-installer.ps1 -PfxPassword "MySecret123"
    .\scripts\sign-installer.ps1 -InstallerPath "Releases\Wattcoin Miner Setup 1.0.220.exe"
#>

param(
    [string]$PfxPassword   = $(if ($env:WATTCOIN_PFX_PASSWORD) { $env:WATTCOIN_PFX_PASSWORD } else { "WattcoinDev" }),
    [string]$InstallerPath = "",
    [string]$TimestampUrl  = "http://timestamp.digicert.com"
)

$ErrorActionPreference = "Stop"

# --------------------------------------------------------------------------- #
#  Tool & cert paths
# --------------------------------------------------------------------------- #
$SDK_BIN  = if ($env:WATTCOIN_SDK_BIN) {
    $env:WATTCOIN_SDK_BIN
} else {
    # Auto-detect latest Windows SDK
    $kitRoot = "${env:ProgramFiles(x86)}\Windows Kits\10\bin"
    $sdkDirs = Get-ChildItem $kitRoot -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending
    $sdkDir = $sdkDirs | Select-Object -First 1
    if ($sdkDir) { Join-Path $sdkDir.FullName "x64" } else { "" }
}
$SIGNTOOL = Join-Path $SDK_BIN "signtool.exe"
$CERT_PFX = Join-Path (Split-Path $PSScriptRoot -Parent) "certs\sign.pfx"
$RELEASES = Join-Path (Split-Path $PSScriptRoot -Parent) "Releases"

if (-not (Test-Path $SIGNTOOL)) {
    throw "signtool.exe not found at: $SIGNTOOL"
}
if (-not (Test-Path $CERT_PFX)) {
    throw "sign.pfx not found at: $CERT_PFX`n  Run '.\scripts\make-dev-cert.ps1' first."
}

# --------------------------------------------------------------------------- #
#  Resolve installer path
# --------------------------------------------------------------------------- #
if ($InstallerPath -eq "") {
    $installer = Get-ChildItem $RELEASES -Filter "Wattcoin Miner Setup *.exe" -ErrorAction SilentlyContinue |
        Sort-Object {
            # Sort by parsed version so "1.0.10" > "1.0.9" (not lexicographic)
            if ($_.Name -match "(\d+)\.(\d+)\.(\d+)") {
                [int]$Matches[1] * 1000000 + [int]$Matches[2] * 1000 + [int]$Matches[3]
            } else { 0 }
        } -Descending |
        Select-Object -First 1

    if ($null -eq $installer) {
        throw "No installer found in: $RELEASES`n  Build the installer first."
    }
    $InstallerPath = $installer.FullName
}

if (-not (Test-Path $InstallerPath)) {
    throw "Installer not found: $InstallerPath"
}

# --------------------------------------------------------------------------- #
#  Sign
# --------------------------------------------------------------------------- #
Write-Host ""
Write-Host "Signing: $InstallerPath" -ForegroundColor Cyan
Write-Host "  Certificate : $CERT_PFX"
Write-Host "  Timestamp   : $TimestampUrl"
Write-Host ""

& $SIGNTOOL sign `
    /f $CERT_PFX `
    /p $PfxPassword `
    /fd sha256 `
    /t $TimestampUrl `
    /v `
    $InstallerPath

if ($LASTEXITCODE -ne 0) { throw "signtool.exe sign failed (exit code $LASTEXITCODE)" }
Write-Host ""
Write-Host "  [OK] Installer signed successfully." -ForegroundColor Green

# --------------------------------------------------------------------------- #
#  Verify
# --------------------------------------------------------------------------- #
Write-Host ""
Write-Host "Verifying signature..." -ForegroundColor Cyan

& $SIGNTOOL verify /pa /v $InstallerPath

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "  [WARN] Verification reported an error." -ForegroundColor Yellow
    Write-Host "         For a self-signed dev cert this is expected on machines where" -ForegroundColor Yellow
    Write-Host "         the root CA has not been installed (make-dev-cert.ps1 installs it" -ForegroundColor Yellow
    Write-Host "         on the build machine only)." -ForegroundColor Yellow
} else {
    Write-Host ""
    Write-Host "  [OK] Signature verified." -ForegroundColor Green
}

Write-Host ""
