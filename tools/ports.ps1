<#
  列出串口【并标出是哪个设备】—— 避免采集时误连到蓝牙虚拟串口。
  用法：  .\tools\ports.ps1
  判读：
     · "USB Serial Device (COMx)" 且 VID_2E8A  ⇒ 这是 RP2350/RP2040（我们要的）✓
     · "Standard Serial over Bluetooth link"    ⇒ 蓝牙虚拟串口，别选 ✗
     · 其它（USB-SERIAL CH340 等）              ⇒ 其它 USB 转串口
#>
$ports = Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue |
         Where-Object { $_.Name -match '\(COM\d+\)' } |
         Sort-Object Name
if (-not $ports) { Write-Host "没找到任何串口" -ForegroundColor Yellow; exit 0 }

foreach ($p in $ports) {
    $com = ([regex]::Match($p.Name, '\((COM\d+)\)')).Groups[1].Value
    $vid = ([regex]::Match($p.DeviceID, 'VID_([0-9A-Fa-f]{4})')).Groups[1].Value
    $tag = "  "
    $col = 'Gray'
    if ($vid -eq '2E8A') { $tag = "★ "; $col = 'Green' }        # Raspberry Pi (RP2040/RP2350)
    elseif ($p.Name -match 'Bluetooth|蓝牙') { $tag = "✗ "; $col = 'DarkGray' }
    Write-Host ("{0}{1,-7} {2}" -f $tag, $com, $p.Name) -ForegroundColor $col
}
Write-Host "`n★ = Raspberry Pi 芯片的 USB 串口（探针就是这个）" -ForegroundColor Green
Write-Host "✗ = 蓝牙虚拟串口，采集时不要选" -ForegroundColor DarkGray
