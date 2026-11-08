Write-Output '---EVENTLOG---'
Get-WinEvent -FilterHashtable @{ LogName='Application'; StartTime=(Get-Date).AddMinutes(-30) } -ErrorAction SilentlyContinue |
  Where-Object { $_.ProviderName -match 'Windows Error Reporting|Application Error|Chrome|Kaspersky' -or $_.Message -match 'chrome' } |
  Select-Object -First 8 TimeCreated, ProviderName, Id, @{n='Msg';e={($_.Message -split "`r`n")[0..6] -join ' | '}} |
  Format-List | Out-String
Write-Output '---CRASHPAD---'
Get-ChildItem 'C:\Users\abhi0\AppData\Local\Temp\neelima-e2e-profile\Crashpad\reports' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 5 Name, LastWriteTime | Format-Table -AutoSize | Out-String
Write-Output '---AVPROCS---'
Get-Process | Where-Object { $_.ProcessName -match 'kav|avp|klif' } | Select-Object ProcessName, Id | Format-Table -AutoSize | Out-String
