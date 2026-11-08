# Preflight state check after Freebuff restart
Write-Output '---PROCS---'
Get-Process -Name neelima -ErrorAction SilentlyContinue | Select-Object Id, ProcessName | Format-Table -AutoSize | Out-String
Write-Output '---CHROME-CMDS---'
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue | ForEach-Object { $_.CommandLine } | Select-String -Pattern 'user-data-dir|neelima' | Out-String
Write-Output '---REG-CHROME---'
$k = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.neelima.bridge'
if (Test-Path $k) { (Get-ItemProperty $k).'(default)' } else { 'MISSING' }
Write-Output '---REG-EDGE---'
$k = 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.neelima.bridge'
if (Test-Path $k) { (Get-ItemProperty $k).'(default)' } else { 'MISSING' }
Write-Output '---TMPDIRS---'
Get-ChildItem "$env:TEMP" -Directory -Filter 'neelima-*' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName | Out-String
Write-Output '---APPDATA---'
Get-ChildItem $env:APPDATA -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'neelima' } | Select-Object -ExpandProperty FullName | Out-String
Get-ChildItem $env:LOCALAPPDATA -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'neelima' } | Select-Object -ExpandProperty FullName | Out-String
