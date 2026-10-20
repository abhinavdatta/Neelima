$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repoRoot 'browser-extension'
$outDir = Join-Path $repoRoot 'dist'
$archive = Join-Path $outDir 'Neelima-Browser-Extension.zip'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
Compress-Archive -Path (Join-Path $source '*') -DestinationPath $archive -CompressionLevel Optimal
$hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath "$archive.sha256" -Value "$hash  Neelima-Browser-Extension.zip" -Encoding ascii
Write-Output "Created $archive"
Write-Output "SHA256 $hash"
