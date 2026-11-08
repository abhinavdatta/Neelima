Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine } | ForEach-Object {
  $ud = if ($_.CommandLine -match 'user-data-dir=(\S+)') { $Matches[1] } else { '(default)' }
  '{0}  pid={1}  dbg={2}' -f $ud, $_.ProcessId, (if ($_.CommandLine -match 'remote-debugging-port=(\d+)') { $Matches[1] } else { 'none' })
} | Out-String
