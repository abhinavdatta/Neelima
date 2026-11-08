Add-Type -Namespace W2 -Name F -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
public delegate bool EnumProc(IntPtr h, IntPtr lp);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, System.Text.StringBuilder sb, int max);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder sb, int max);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
'@
$cb = {
  param($h, $lp)
  if (-not [W2.F]::IsWindowVisible($h)) { return $true }
  $sb = New-Object System.Text.StringBuilder 256
  [W2.F]::GetClassNameW($h, $sb, 256) | Out-Null
  $tb = New-Object System.Text.StringBuilder 256
  [W2.F]::GetWindowTextW($h, $tb, 256) | Out-Null
  $pidv = [uint32]0
  [W2.F]::GetWindowThreadProcessId($h, [ref]$pidv) | Out-Null
  $name = $sb.ToString()
  $title = $tb.ToString()
  if ($name -eq '#32770' -or $name -match 'Chrome' -or $title -match 'extension|Folder|Select') {
    Write-Output ("class={0} title={1} pid={2} hwnd={3}" -f $name, $title, $pidv, $h)
  }
  return $true
}
[W2.F]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
$chromePids = (Get-Process chrome -ErrorAction SilentlyContinue).Id
Write-Output ("chrome pids: {0}" -f ($chromePids -join ','))
