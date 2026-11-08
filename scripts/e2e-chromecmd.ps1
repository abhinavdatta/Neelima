Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ForEach-Object {
  $ud = if ($_.CommandLine -match 'user-data-dir=(\S+)') { $Matches[1] } else { '(none)' }
  $dbg = if ($_.CommandLine -match 'remote-debugging-port=(\d+)') { $Matches[1] } else { 'none' }
  '{0} pid={1} dbg={2}' -f $ud, $_.ProcessId, $dbg
} | Out-String
