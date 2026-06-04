param(
    [string]$OutputDir = (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "gen")
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

function Convert-HlslToC {
    param([string]$HlslPath, [string]$VarName)
    $lines = Get-Content $HlslPath -Raw
    $escaped = $lines -replace '\\', '\\' -replace '"', '\"' -replace '\r', ''
    $escaped = $escaped -replace "`n", "\n"
    @"
// Generated from $((Get-Item $HlslPath).Name) - do not edit
static const char $VarName[] =
    "$escaped";
"@
}

# Generate D3D11/12 compute shaders
$compute = Convert-HlslToC -HlslPath "$ScriptDir\compute.hlsl" -VarName "g_compute_hlsl"
$proof = Convert-HlslToC -HlslPath "$ScriptDir\proof.hlsl" -VarName "g_proof_hlsl"

@"
/* Generated shader source strings - do not edit */
$compute

$proof
"@ | Out-File -FilePath "$OutputDir\shaders.c" -Encoding ASCII -NoNewline

Write-Output "Generated $OutputDir\shaders.c"

# Generate D3D9 pixel shaders
$d3d9Load = Convert-HlslToC -HlslPath "$ScriptDir\d3d9_load.hlsl" -VarName "g_d3d9_load_ps"
$d3d9Proof = Convert-HlslToC -HlslPath "$ScriptDir\d3d9_proof.hlsl" -VarName "g_d3d9_proof_ps"

@"
/* Generated D3D9 shader source strings - do not edit */
$d3d9Load

$d3d9Proof
"@ | Out-File -FilePath "$OutputDir\shaders_d3d9.c" -Encoding ASCII -NoNewline

Write-Output "Generated $OutputDir\shaders_d3d9.c"
