param([string]$Path)
Add-Type -Namespace Win -Name FM -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
public delegate bool EnumProc(IntPtr h, IntPtr lp);
[DllImport("user32.dll")] public static extern int GetClassNameW(IntPtr h, System.Text.StringBuilder sb, int max);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string cls, string title);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageW(IntPtr h, int msg, IntPtr wp, string lp);
[DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr h, int msg, IntPtr wp, IntPtr lp);
[DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h, int msg, IntPtr wp, IntPtr lp);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
'@
$chromeProcs = @{}
Get-Process chrome -ErrorAction SilentlyContinue | ForEach-Object { $chromeProcs[[uint32]$_.Id] = $true }
$found = $null
$cb = {
  param($h, $lp)
  if (-not [Win.FM]::IsWindowVisible($h)) { return $true }
  $spr = [uint32]0
  [Win.FM]::GetWindowThreadProcessId($h, [ref]$spr) | Out-Null
  if (-not $chromeProcs.ContainsKey($spr)) { return $true }
  $sb = New-Object System.Text.StringBuilder 256
  [Win.FM]::GetClassNameW($h, $sb, 256) | Out-Null
  if ($sb.ToString() -eq '#32770') { $pidOwner = $spr; $script:found = $h }
  return $true
}
[Win.FM]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
if (-not $found) { Write-Output 'DIALOG-NOT-FOUND'; exit 1 }
Write-Output ("dialog {0}" -f $found)
$edit = [Win.FM]::FindWindowExW($found, [IntPtr]::Zero, 'Edit', $null)
if ($edit -eq [IntPtr]::Zero) { Write-Output 'EDIT-NOT-FOUND'; exit 1 }
[Win.FM]::SendMessageW($edit, 0x000C, [IntPtr]::Zero, $Path) | Out-Null   # WM_SETTEXT
Start-Sleep -Milliseconds 800
# Press the Select Folder / Open button: WM_COMMAND with IDOK (1)
[Win.FM]::PostMessageW($found, 0x0111, [IntPtr]1, [IntPtr]::Zero) | Out-Null
Start-Sleep -Milliseconds 1500
Write-Output 'SENT'
