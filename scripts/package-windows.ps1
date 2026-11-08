# Phase 6 packaging: produce distributable Windows artifacts for Neelima.
# Outputs to dist/neelima-windows/:
#   - Neelima-Browser-Extension.zip (+ .sha256)   load-unpacked extension
#   - neelima_native_host.exe                     native messaging host
#   - manifests/com.neelima.browser_bridge.json   registration manifest template
#   - register.ps1 / (built-in -Unregister)       host registration
# Signing and publishing are separate, explicit release actions.
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $repoRoot 'dist\neelima-windows'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

Write-Host "== 1/4 browser extension package ==" -ForegroundColor Cyan
& (Join-Path $PSScriptRoot 'package-browser-extension.ps1')

Write-Host "== 2/4 native messaging host (release) ==" -ForegroundColor Cyan
Push-Location (Join-Path $repoRoot 'native-host')
cargo build --release
if ($LASTEXITCODE -ne 0) { Pop-Location; throw 'native-host release build failed' }
Pop-Location
$hostExe = Join-Path $repoRoot 'target\release\neelima_native_host.exe'
if (-not (Test-Path $hostExe)) { throw "native host binary missing at $hostExe" }
Copy-Item $hostExe (Join-Path $outDir 'neelima_native_host.exe') -Force

Write-Host "== 3/4 registration manifest + script ==" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path (Join-Path $outDir 'manifests') | Out-Null
Copy-Item (Join-Path $repoRoot 'native-host\manifests\windows\com.neelima.browser_bridge.json') `
    (Join-Path $outDir 'manifests\com.neelima.browser_bridge.json') -Force
Copy-Item (Join-Path $repoRoot 'native-host\manifests\windows\register.ps1') `
    (Join-Path $outDir 'register.ps1') -Force
Copy-Item (Join-Path $repoRoot 'INSTALL.md') (Join-Path $outDir 'INSTALL.md') -Force

Write-Host "== 4/4 verify packaged manifest points at the shipped binary name ==" -ForegroundColor Cyan
$manifest = Get-Content (Join-Path $outDir 'manifests\com.neelima.browser_bridge.json') -Raw | ConvertFrom-Json
if ($manifest.path -notlike '*neelima_native_host.exe') { throw "manifest path '$($manifest.path)' does not name the shipped binary" }
$shippedHash = (Get-FileHash (Join-Path $outDir 'neelima_native_host.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath (Join-Path $outDir 'neelima_native_host.exe.sha256') -Value "$shippedHash  neelima_native_host.exe" -Encoding ascii
Write-Host "native host SHA256 $shippedHash"

Write-Host ""
Write-Host "Packaged artifacts in $outDir" -ForegroundColor Green
Get-ChildItem -Recurse $outDir | Select-Object FullName, Length | Format-Table -AutoSize
