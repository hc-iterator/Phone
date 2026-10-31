# 提权执行：建还原点 → 静默安装 Parsec VDD 0.41 → 验证
# 由 DSH 以 Start-Process -Verb RunAs 拉起（会弹 UAC，需用户点"是"）
$log = Join-Path $env:TEMP 'vdd-install.log'
function L($m) { "$(Get-Date -Format 'HH:mm:ss')  $m" | Tee-Object -FilePath $log -Append }
"=== 开始 $(Get-Date) ===" | Out-File -FilePath $log -Encoding utf8

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
L "管理员=$isAdmin"
if (-not $isAdmin) { L '不是管理员，退出'; exit 1 }

# 1) 还原点（系统保护没开就先开；失败不阻断，只记录）
try {
  L '尝试开启系统保护(C:)'
  Enable-ComputerRestore -Drive 'C:\' -ErrorAction Stop
} catch { L "Enable-ComputerRestore 失败（可能已开启或无权限）：$($_.Exception.Message)" }

try {
  L '创建还原点'
  Checkpoint-Computer -Description 'before parsec-vdd 0.41' -RestorePointType 'MODIFY_SETTINGS' -ErrorAction Stop
  L '还原点已创建'
} catch {
  L "还原点创建失败：$($_.Exception.Message)"
}

# 2) 静默安装
$exe = Join-Path $env:TEMP 'parsec-vdd-0.41.0.0.exe'
if (-not (Test-Path $exe)) { L "找不到安装包 $exe"; exit 2 }
try {
  L "安装 $exe /S"
  $p = Start-Process -FilePath $exe -ArgumentList '/S' -Wait -PassThru
  L "安装退出码 = $($p.ExitCode)"
} catch { L "安装失败：$($_.Exception.Message)"; exit 3 }

# 3) 验证驱动是否注册
Start-Sleep -Seconds 2
$dev = Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -match 'Parsec|VDD' -or $_.InstanceId -match 'Parsec' }
if ($dev) {
  foreach ($d in $dev) { L ("设备: {0} | {1} | {2}" -f $d.FriendlyName, $d.Status, $d.InstanceId) }
} else {
  L '未发现 Parsec 设备节点（可能安装器需要重启，或已安装但未创建节点）'
}

# 4) 当前显示适配器（供对照）
L '--- 显示适配器 ---'
Get-CimInstance Win32_VideoController | ForEach-Object { L ("  {0}  {1}x{2}" -f $_.Name, $_.CurrentHorizontalResolution, $_.CurrentVerticalResolution) }

L '=== 完成 ==='
