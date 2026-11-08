param([int]$px, [int]$py)
$ErrorActionPreference = "Stop"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinC {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$p = Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -match 'Chrome' } | Select-Object -First 1
if (-not $p) { Write-Output 'NO-WINDOW'; exit 1 }
$h = $p.MainWindowHandle
$r = New-Object WinC+RECT
[WinC]::GetWindowRect($h, [ref]$r) | Out-Null
$x = $r.Left + $px; $y = $r.Top + $py
[WinC]::SetCursorPos($x, $y) | Out-Null
Start-Sleep -Milliseconds 250
[WinC]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 120
[WinC]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
Write-Output "clicked ${x},${y}"
