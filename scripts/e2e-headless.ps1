Stop-Process -Name chrome -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$profileDir = "$env:LOCALAPPDATA\Temp\neelima-e2eprofile"
$argLines = @(
  "--user-data-dir=""$profileDir""",
  '--remote-debugging-port=9222',
  '--no-first-run',
  '--no-default-browser-check'
)
$p = Start-Process 'C:\Program Files\Google\Chrome\Application\chrome.exe' -ArgumentList $argLines -PassThru
Write-Output "launcher-pid $($p.Id)"
Start-Sleep -Seconds 8
