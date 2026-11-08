$extraPath = 'C:\Users\abhi0\Desktop\New folder\zodecpy\.tmp\e2e-extraargs.txt'
$profileDir = "$env:LOCALAPPDATA\Temp\neelima-e2eprofile"
Stop-Process -Name chrome -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$extraRaw = Get-Content $extraPath -Raw
$argLines = @(
  "--user-data-dir=""$profileDir""",
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-session-crashed-bubble',
  '--hide-crash-restore-bubble'
)
foreach ($line in ($extraRaw -split "`n")) {
  $v = $line.Trim()
  if ($v) { $argLines += $v }
}
$p = Start-Process 'C:\Program Files\Google\Chrome\Application\chrome.exe' -ArgumentList $argLines -PassThru
Write-Output "launcher-pid $($p.Id)"
Start-Sleep -Seconds 10
foreach ($line in $argLines) { Write-Output "arg: $line" }
