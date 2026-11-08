param([string]$ProfileDir = "$env:LOCALAPPDATA\Temp\neelima-e2eprofile", [string]$Extra = '')
$argLines = @(
  "--user-data-dir=""$ProfileDir""",
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-session-crashed-bubble',
  '--hide-crash-restore-bubble'
)
# Extra args are newline-separated so spaces inside paths are preserved safely.
foreach ($line in ($Extra -split "`n")) {
  $v = $line.Trim()
  if ($v) { $argLines += $v }
}
$p = Start-Process 'C:\Program Files\Google\Chrome\Application\chrome.exe' -ArgumentList $argLines -PassThru
Write-Output "launcher-pid $($p.Id)"
for ($i = 1; $i -le 6; $i++) {
  Start-Sleep -Seconds 5
  $c = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'").Count
  Write-Output ("{0}s chromium-processes {1}" -f ($i * 5), $c)
}
