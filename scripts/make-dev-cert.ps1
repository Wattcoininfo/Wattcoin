<#
.SYNOPSIS
    Creates a self-signed development code-signing certificate (no GUI, fully
    unattended) and installs the root CA to the local machine's Trusted Root store.

.DESCRIPTION
    Workflow:
      1. New-SelfSignedCertificate -> root CA  (stored in CurrentUser\My)
      2. New-SelfSignedCertificate -> code-signing leaf cert signed by root CA
      3. Export-PfxCertificate     -> writes certs\sign.pfx
      4. Export-Certificate        -> writes certs\root.cer
      5. Import-Certificate        -> installs root CA to LocalMachine\Root

    No GUI dialogs.  Requires administrator rights for step 5 only.

.PARAMETER PfxPassword
    Password to protect the exported sign.pfx.  Defaults to "WattcoinDev".

.PARAMETER OutputDir
    Directory where root.cer and sign.pfx are written.
    Defaults to <repo-root>\certs\.

.EXAMPLE
    .\scripts\make-dev-cert.ps1
    .\scripts\make-dev-cert.ps1 -PfxPassword "MySecret123"
#>

#Requires -RunAsAdministrator

param(
    [string]$PfxPassword = "WattcoinDev",
    [string]$OutputDir   = (Join-Path (Split-Path $PSScriptRoot -Parent) "certs")
)

$ErrorActionPreference = "Stop"

# --------------------------------------------------------------------------- #
#  Output paths
# --------------------------------------------------------------------------- #
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$rootCer = Join-Path $OutputDir "root.cer"
$signPfx = Join-Path $OutputDir "sign.pfx"

# --------------------------------------------------------------------------- #
#  Step 1 — Root CA
# --------------------------------------------------------------------------- #
Write-Host ""
Write-Host "=== Step 1 / 4 : Creating root CA certificate ===" -ForegroundColor Cyan

$rootCert = New-SelfSignedCertificate `
    -Type Custom `
    -KeySpec Signature `
    -Subject "CN=Wattcoin Dev Root CA" `
    -KeyExportPolicy Exportable `
    -KeyAlgorithm RSA `
    -KeyLength 2048 `
    -KeyUsageProperty Sign `
    -KeyUsage CertSign `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -NotAfter (Get-Date).AddYears(5)

Write-Host "  [OK] Root CA: $($rootCert.Thumbprint)" -ForegroundColor Green

# --------------------------------------------------------------------------- #
#  Step 2 — Code-signing leaf cert
# --------------------------------------------------------------------------- #
Write-Host ""
Write-Host "=== Step 2 / 4 : Creating code-signing certificate ===" -ForegroundColor Cyan

$leafCert = New-SelfSignedCertificate `
    -Type Custom `
    -KeySpec Signature `
    -Subject "CN=Wattcoin Dev" `
    -KeyExportPolicy Exportable `
    -KeyAlgorithm RSA `
    -KeyLength 2048 `
    -KeyUsageProperty Sign `
    -KeyUsage DigitalSignature `
    -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3") `
    -Signer $rootCert `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -NotAfter (Get-Date).AddYears(3)

Write-Host "  [OK] Signing cert: $($leafCert.Thumbprint)" -ForegroundColor Green

# --------------------------------------------------------------------------- #
#  Step 3 — Export leaf to PFX
# --------------------------------------------------------------------------- #
Write-Host ""
Write-Host "=== Step 3 / 4 : Exporting PFX ===" -ForegroundColor Cyan

$securePassword = ConvertTo-SecureString -String $PfxPassword -Force -AsPlainText
Export-PfxCertificate -Cert $leafCert -FilePath $signPfx -Password $securePassword -ChainOption EndEntityCertOnly | Out-Null

Write-Host "  [OK] PFX written: $signPfx" -ForegroundColor Green

# --------------------------------------------------------------------------- #
#  Step 4 — Export root CA cert and install as trusted
# --------------------------------------------------------------------------- #
Write-Host ""
Write-Host "=== Step 4 / 4 : Installing root CA to Trusted Root store ===" -ForegroundColor Cyan

Export-Certificate -Cert $rootCert -FilePath $rootCer | Out-Null
Import-Certificate -FilePath $rootCer -CertStoreLocation "Cert:\LocalMachine\Root" | Out-Null

Write-Host "  [OK] Root CA installed as trusted." -ForegroundColor Green

# --------------------------------------------------------------------------- #
#  Save password and thumbprint for auto-signing during builds
# --------------------------------------------------------------------------- #
Set-Content -Path (Join-Path $OutputDir ".password")   -Value $PfxPassword            -NoNewline
Set-Content -Path (Join-Path $OutputDir ".thumbprint") -Value $leafCert.Thumbprint    -NoNewline
Write-Host "  [OK] Password saved   : $(Join-Path $OutputDir '.password')" -ForegroundColor Green
Write-Host "  [OK] Thumbprint saved : $(Join-Path $OutputDir '.thumbprint') ($($leafCert.Thumbprint))" -ForegroundColor Green

# --------------------------------------------------------------------------- #
#  Clean up temp entries from CurrentUser\My
# --------------------------------------------------------------------------- #
Remove-Item "Cert:\CurrentUser\My\$($rootCert.Thumbprint)" -ErrorAction SilentlyContinue
Remove-Item "Cert:\CurrentUser\My\$($leafCert.Thumbprint)" -ErrorAction SilentlyContinue

# --------------------------------------------------------------------------- #
#  Summary
# --------------------------------------------------------------------------- #
Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  Dev certificate ready." -ForegroundColor Green
Write-Host ""
Write-Host "  PFX file     : $signPfx"
Write-Host "  PFX password : $PfxPassword"
Write-Host ""
Write-Host "  To sign an installer, run:" -ForegroundColor Cyan
Write-Host "    .\scripts\sign-installer.ps1" -ForegroundColor White
Write-Host "    .\scripts\sign-installer.ps1 -PfxPassword `"$PfxPassword`"" -ForegroundColor White
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""
