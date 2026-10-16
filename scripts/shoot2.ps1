$ErrorActionPreference = "Stop"
$OutDir = "docs/screenshots"
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$p = Get-Process neelima -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
if (-not $p) {
  $p = Start-Process -FilePath "target\release\neelima.exe" -PassThru
  Start-Sleep -Seconds 6
  $p.Refresh()
}
$h = $p.MainWindowHandle
[Win]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 900

function Click([int]$px, [int]$py) {
  $r = New-Object Win+RECT
  [Win]::GetWindowRect($h, [ref]$r) | Out-Null
  $x = $r.Left + $px; $y = $r.Top + $py
  [Win]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 250
  [Win]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)  # left down
  [Win]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)  # left up
}

function Shoot([string]$name) {
  $r = New-Object Win+RECT
  [Win]::GetWindowRect($h, [ref]$r) | Out-Null
  $w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
  $bmp = New-Object System.Drawing.Bitmap $w, $ht
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size($w, $ht)))
  $bmp.Save((Join-Path $OutDir "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host "saved $name.png"
}

$ws = New-Object -ComObject WScript.Shell

# 1. Folder "..." menu on the task1 project row
Click 351 327
Start-Sleep -Milliseconds 900
Shoot "02-folder-menu"

# close the menu (Escape) then open the terminal panel from the titlebar
$ws.AppActivate($p.Id) | Out-Null
Start-Sleep -Milliseconds 300
$ws.SendKeys('{ESC}') | Out-Null
Start-Sleep -Milliseconds 500
Click 1237 30
Start-Sleep -Seconds 2
Shoot "03-terminal"

# close terminal, open Settings modal (gear, bottom of sidebar)
$ws.AppActivate($p.Id) | Out-Null
$ws.SendKeys('{ESC}') | Out-Null
Start-Sleep -Milliseconds 400
Click 313 856
Start-Sleep -Milliseconds 900
Shoot "04-settings"

Stop-Process -Id $p.Id -Force
Write-Host 'done'
