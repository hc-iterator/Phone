<#
  TMDS 采样探针 —— 串口采集脚本

  用法：
      .\tools\sampler_capture.ps1 -List                       # 列出可用串口
      .\tools\sampler_capture.ps1 -Port COM7                  # 抓一次（默认存 capture.txt）
      .\tools\sampler_capture.ps1 -Port COM7 -Out a.txt       # 指定输出
      .\tools\sampler_capture.ps1 -Port COM7 -Status          # 只问状态（h/s 命令）

  原理：探针的 'd' 命令会打印 BEGIN ... 16 行 hex ... END
        本脚本打开串口、发 'd'、一直读到 END 为止，把内容存成文件。
        然后用 python tools\tmds_decode.py <文件> 做解码分析。
#>
param(
    [string]$Port = "",
    [string]$Out  = "capture.txt",
    [switch]$List,
    [switch]$Status,
    [int]$Baud = 115200,
    [int]$TimeoutSec = 30
)
$ErrorActionPreference = 'Continue'

if ($List -or [string]::IsNullOrWhiteSpace($Port)) {
    Write-Host "可用串口：" -ForegroundColor Cyan
    [System.IO.Ports.SerialPort]::GetPortNames() | ForEach-Object { Write-Host "  $_" }
    if ([string]::IsNullOrWhiteSpace($Port)) { Write-Host "`n用法见本脚本头部注释。" -ForegroundColor DarkGray; exit 0 }
}

try { $sp = New-Object System.IO.Ports.SerialPort $Port, $Baud, 'None', 8, 'One' }
catch { Write-Host "打不开 $Port : $_" -ForegroundColor Red; exit 1 }
$sp.ReadTimeout = 2000
try { $sp.Open() } catch { Write-Host "打开 $Port 失败: $_" -ForegroundColor Red; exit 1 }
Write-Host "已打开 $Port" -ForegroundColor Green

# 清掉上电噪声
Start-Sleep -Milliseconds 300
while ($sp.BytesToRead -gt 0) { $null = $sp.ReadExisting() }

$cmd = if ($Status) { "s" } else { "d" }
$sp.Write($cmd)
Write-Host "已发送命令 '$cmd'，等待数据（最多 $TimeoutSec 秒）..."

$sb = New-Object System.Text.StringBuilder
$deadline = (Get-Date).AddSeconds($TimeoutSec)
$done = $false
while ((Get-Date) -lt $deadline -and -not $done) {
    try {
        $chunk = $sp.ReadExisting()
        if ($chunk) {
            [void]$sb.Append($chunk)
            if ($sb.ToString() -match '(?m)^END\s*$' -or ($Status -and $sb.ToString() -match 'STAT ')) { $done = $true }
        } else { Start-Sleep -Milliseconds 50 }
    } catch { Start-Sleep -Milliseconds 50 }
}
$sp.Close()

$text = $sb.ToString()
if ([string]::IsNullOrWhiteSpace($text)) { Write-Host "没收到数据。检查：探针是否在跑？串口是否是它的 CDC 口？" -ForegroundColor Yellow; exit 2 }

if (-not $Status) {
    Set-Content -Path $Out -Value $text -Encoding UTF8
    $lines = ($text -split "`n").Count
    Write-Host "已保存 $Out （$lines 行）" -ForegroundColor Green
    Write-Host "下一步： python tools\tmds_decode.py $Out" -ForegroundColor Cyan
} else {
    ($text -split "`n" | Where-Object { $_ -match 'STAT|clk|引脚|采样率' }) | ForEach-Object { Write-Host "  $($_.Trim())" }
}
