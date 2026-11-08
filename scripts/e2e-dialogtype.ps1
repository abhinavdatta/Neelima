param([string]$Path)
$ErrorActionPreference = 'Stop'
$ws = New-Object -ComObject WScript.Shell
$ok = $ws.AppActivate('Select the extension directory')
if (-not $ok) { $ok = $ws.AppActivate('Select the extension') }
if (-not $ok) { Write-Output 'ACTIVATE-FAILED'; exit 1 }
Start-Sleep -Milliseconds 600
$ws.SendKeys($Path) | Out-Null
Start-Sleep -Milliseconds 400
$ws.SendKeys('{ENTER}') | Out-Null
Start-Sleep -Milliseconds 1200
Write-Output 'TYPED+ENTER'
