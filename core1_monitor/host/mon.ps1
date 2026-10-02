<#
  mon.ps1 -- 主机侧小工具：跟 core1_monitor 固件说话（不需要任何第三方库）

  用法：
    # 发一条命令看回显
    pwsh -NoProfile -File core1_monitor\host\mon.ps1 -Port COM7 -Cmd "S"

    # 把文件的原始字节写到 flash 地址 10100000（协议 A：raw）
    pwsh -NoProfile -File core1_monitor\host\mon.ps1 -Port COM7 -Addr 10100000 -SendFile .\payload.bin

    # 同一个文件，改用十六进制文本模式（协议 B：hex lines）
    pwsh -NoProfile -File core1_monitor\host\mon.ps1 -Port COM7 -Addr 10100000 -SendFile .\payload.bin -Hex

  说明（为什么这么写）：
    * 只用 System.IO.Ports（.NET 自带），不依赖 pyserial / 任何模块 —— 板子没驱动问题也一样能用。
    * 命令一律以 CR 结尾：固件是按 \r 或 \n 断行的，CR 最省事。
    * 发文件时必须先等到固件打印 READY 再发数据，否则那几 KB 会被当成上一条命令吃掉。
    * -Hex 模式按每行 32 字节发送：固件的接收端会忽略空白，行长短无所谓，分行只是为了好看和可重试。
  * 本脚本所有屏幕输出都是 ASCII（这台机器控制台是 GBK，打中文/符号会崩）。
#>
param(
    [Parameter(Mandatory = $true)][string]$Port,
    [string]$Cmd,
    [string]$SendFile,
    [string]$Addr,
    [switch]$Hex,
    [int]$Baud = 115200,
    [int]$ReadMs = 3000,
    [int]$ReplyMs = 15000
)

$ErrorActionPreference = 'Stop'

if (-not $Cmd -and -not $SendFile) {
    Write-Host "usage: mon.ps1 -Port COM7 [-Cmd 'S'] [-Addr 10100000 -SendFile file [-Hex]]"
    exit 1
}
if ($SendFile -and -not $Addr) {
    Write-Host "ERR: -SendFile needs -Addr (hex, e.g. 10100000)"
    exit 1
}

$sp = New-Object System.IO.Ports.SerialPort($Port, $Baud, [System.IO.Ports.Parity]::None, 8, [System.IO.Ports.StopBits]::One)
$sp.Encoding = [System.Text.Encoding]::ASCII
$sp.ReadTimeout = 200
$sp.WriteTimeout = 8000
$sp.WriteBufferSize = 65536
$sp.DtrEnable = $true
$sp.Open()

# 读一段时间（用于"发完命令看回显"）
function Read-For([int]$ms) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $sb = New-Object System.Text.StringBuilder
    while ($sw.ElapsedMilliseconds -lt $ms) {
        try {
            $s = $sp.ReadExisting()
            if ($s.Length -gt 0) { [void]$sb.Append($s) }
        } catch { }
        Start-Sleep -Milliseconds 10
    }
    $sb.ToString()
}

# 读到出现某个关键字（用于等 READY）；超时返回已经收到的东西
function Read-Until([string]$pattern, [int]$ms) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $sb = New-Object System.Text.StringBuilder
    while ($sw.ElapsedMilliseconds -lt $ms) {
        try {
            $s = $sp.ReadExisting()
            if ($s.Length -gt 0) {
                [void]$sb.Append($s)
                Write-Host -NoNewline $s
                if ($sb.ToString() -match $pattern) { return $true }
            }
        } catch { }
        Start-Sleep -Milliseconds 10
    }
    return $false
}

function Send-Line([string]$line) {
    $sp.Write("$line`r")
    $sp.BaseStream.Flush()
}

try {
    if ($Cmd) {
        Write-Host "--> $Cmd"
        Send-Line $Cmd
        Write-Host -NoNewline (Read-For $ReadMs)
        Write-Host ""
    }

    if ($SendFile) {
        $full = (Resolve-Path -LiteralPath $SendFile).Path
        $bytes = [System.IO.File]::ReadAllBytes($full)
        $len = $bytes.Length
        if ($len -eq 0) { Write-Host "ERR: empty file"; exit 1 }
        if ($len -gt 32768) { Write-Host "ERR: file bigger than the 32768-byte limit of F"; exit 1 }

        $mode = if ($Hex) { "H (hex text)" } else { "raw bytes" }
        Write-Host "--> F $Addr $len $mode   ($full)"
        if ($Hex) { Send-Line "F $Addr $len H" } else { Send-Line "F $Addr $len" }

        if (-not (Read-Until 'READY' 5000)) {
            Write-Host "`nERR: no READY from the monitor (address refused? core0 hung?)"
            exit 2
        }
        Write-Host ""

        if ($Hex) {
            $chunk = 32
            for ($i = 0; $i -lt $len; $i += $chunk) {
                $end = [Math]::Min($i + $chunk - 1, $len - 1)
                $parts = @()
                for ($j = $i; $j -le $end; $j++) { $parts += $bytes[$j].ToString('x2') }
                $sp.Write(($parts -join '') + "`r`n")
            }
            $sp.BaseStream.Flush()
        } else {
            $sp.Write($bytes, 0, $len)
            $sp.BaseStream.Flush()
        }

        Write-Host -NoNewline (Read-For $ReplyMs)
        Write-Host ""
    }
} finally {
    Start-Sleep -Milliseconds 100
    try { $sp.Close() } catch { }
}
