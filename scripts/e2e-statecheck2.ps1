Write-Output '---REG-CHROME---'
$k = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.neelima.browser_bridge'
if (Test-Path $k) { (Get-ItemProperty $k).'(default)' } else { 'MISSING' }
Write-Output '---REG-EDGE---'
$k = 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.neelima.browser_bridge'
if (Test-Path $k) { (Get-ItemProperty $k).'(default)' } else { 'MISSING' }
Write-Output '---MANIFEST---'
Get-Content 'C:\Users\abhi0\AppData\Local\Neelima\com.neelima.browser_bridge.json'
Write-Output '---SETTINGS---'
Get-Content 'C:\Users\abhi0\AppData\Roaming\com.neelima.app\settings.json'
Write-Output '---ROAMING-LIST---'
Get-ChildItem 'C:\Users\abhi0\AppData\Roaming\com.neelima.app' -File | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize | Out-String
