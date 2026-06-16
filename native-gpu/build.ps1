param(
    [string]$OutputDir = "build"
)

$ErrorActionPreference = "Stop"
$SrcDir = Join-Path $PSScriptRoot "src"

# Step 1: Generate shaders.c from HLSL source
Write-Host "=== Generating shaders ==="
& "$SrcDir\gen_shaders.ps1" -OutputDir "$SrcDir\gen"

# Step 2: Find MSVC compiler
Write-Host "=== Setting up VS environment ==="
$vsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vsWhere)) {
    $vsWhere = "${env:ProgramFiles}\Microsoft Visual Studio\Installer\vswhere.exe"
}

$vsPath = ""
if (Test-Path $vsWhere) {
    $vsPath = & $vsWhere -latest -property installationPath
}

if (-not $vsPath) {
    # Fallback: try common VS install paths
    $candidates = @(
        "C:\Program Files\Microsoft Visual Studio\2022\Community",
        "C:\Program Files\Microsoft Visual Studio\2022\Professional",
        "C:\Program Files\Microsoft Visual Studio\2022\Enterprise",
        "C:\Program Files\Microsoft Visual Studio\2019\Community",
        "C:\Program Files\Microsoft Visual Studio\2019\Professional",
        "C:\Program Files\Microsoft Visual Studio\2019\Enterprise"
    )
    foreach ($c in $candidates) {
        if (Test-Path "$c\VC\Auxiliary\Build\vcvars64.bat") {
            $vsPath = $c
            break
        }
    }
}

if (-not $vsPath) {
    Write-Error "Visual Studio not found. Install Visual Studio 2019+ with 'Desktop development with C++' workload."
    exit 1
}

$vcvars = Join-Path $vsPath "VC\Auxiliary\Build\vcvars64.bat"
Write-Host "Using VS: $vsPath"

# Step 3: Compile via cmd.exe so vcvars environment propagates
Write-Host "=== Compiling gpu-miner.exe ==="
$outDir = Join-Path $PSScriptRoot $OutputDir
New-Item -ItemType Directory -Path $outDir -Force | Out-Null
$outExe = Join-Path $outDir "gpu-miner.exe"

$compileCmd = @"
call "$vcvars" > nul
rc.exe /nologo /fo"$SrcDir\version.res" "$SrcDir\version.rc"
cl.exe /nologo /O2 /MT /GL- /EHsc /Fe"$outExe" "$SrcDir\main.cpp" "$SrcDir\gen\shaders.c" "$SrcDir\gen\shaders_d3d9.c" "$SrcDir\version.res" user32.lib d3d10_1.lib
"@
Write-Host "Compiling main.cpp with MSVC..."
cmd /c $compileCmd
if ($LASTEXITCODE -ne 0) {
    $exitCode = $LASTEXITCODE
    Write-Error "Compilation failed (exit code: $exitCode)"
    exit $exitCode
}

# Remove intermediate files
Get-ChildItem "$SrcDir\*.obj" -ErrorAction SilentlyContinue | Remove-Item
Get-ChildItem "$SrcDir\*.res" -ErrorAction SilentlyContinue | Remove-Item
Get-ChildItem "$PSScriptRoot\*.obj" -ErrorAction SilentlyContinue | Remove-Item

Write-Host "=== Done: $outExe ==="
Write-Host "Size: $((Get-Item $outExe).Length / 1024) KB"
