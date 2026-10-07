<#
  serial-session.ps1 -- 常驻串口会话（dsh-picophone 的 pico_console 用它）。

  为什么要单独一个常驻进程：
    tools\serial_worker.ps1 每次调用都要 Open() 一次，实测一次 open 要 4.5~4.7 秒。
    DVI 台架是【按键驱动】的（K/M/G/V/R），每按一个键都重开一次口，太贵。
    这里 open 一次、之后随便 send/read，空闲超时由父进程（插件）决定何时关。

  为什么要【持续排空】而不是"读到才排空"：
    端口在没人 Read 的时候，数据堆在驱动缓冲里；等 read 命令来了再一次性吐出，
    就会把 8 秒里每 2 秒一条的 4 组输出，全部盖成同 5 毫秒内的戳 ✗ ——
    时间戳会骗人，而"每隔 30 秒闪一次"这类结论恰恰只能靠时间戳证。
    ⇒ 主循环每 ~20ms 排空一次串口，按【到达时刻】入行缓冲；read 只从缓冲取。

  协议：stdin 一行一个 JSON，stdout 一行一个 JSON。
    命令  {"cmd":"open","port":"COM7"|"vid":"2E8A","pid":"0009","baud":115200}
          {"cmd":"send","data":"G\r","escapes":true}
          {"cmd":"read","timeoutMs":2000,"until":"MATCH","stamp":true}
          {"cmd":"close"} | {"cmd":"ping"} | {"cmd":"quit"}
    事件  {"event":"opened","port":"COM7","dtr":true}
          {"event":"sent","bytes":2}
          {"event":"data","text":"...","matched":true,"bytes":131,"lines":12,"timedOut":false}
          {"event":"closed"} {"event":"pong"} {"event":"error","message":"..."}

  ⚠️ Open() 在被占用时会【永久阻塞】——父进程必须用超时 + 杀进程树来兜住它（插件里做了）。
  ⚠️ 参数名不许叫 -Pid：$PID 是只读自动变量（见 Resolve-Port 注释）。
#>
[CmdletBinding()]
param([int]$Baud = 115200)

$ErrorActionPreference = 'Continue'
try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch { }

$script:sp = $null
$script:partial = ''
$script:bytes = 0
$script:lines = New-Object System.Collections.Generic.List[string]
$script:maxLines = 5000

function Emit {
    param($Obj)
    $json = $Obj | ConvertTo-Json -Compress -Depth 6
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

function Resolve-Port {
    # ⚠️ 参数名【不能】叫 -Pid：$PID 是 PowerShell 只读自动变量，赋值会抛
    #    "Cannot overwrite variable Pid because it is read-only or constant"，
    #    端口就变成空串。tools\serial.ps1 当年踩过同一个坑（那边用 -ProductId + 别名）。
    param([string]$Port, [string]$Vid, [string]$ProductId)
    if ($Port -ne '') { return $Port }
    if ($Vid -eq '' -or $ProductId -eq '') { return '' }
    $wantV = $Vid.ToUpper()
    $wantP = $ProductId.ToUpper()
    $devices = @()
    try { $devices = @(Get-CimInstance -ClassName Win32_PnPEntity -ErrorAction Stop) } catch { $devices = @() }
    foreach ($d in $devices) {
        $did = [string]$d.DeviceID
        if ($did -notmatch 'VID_') { continue }
        $m = [regex]::Match($did, 'VID_([0-9A-Fa-f]{4})&PID_([0-9A-Fa-f]{4})')
        if (-not $m.Success) { continue }
        if ($m.Groups[1].Value.ToUpper() -ne $wantV) { continue }
        if ($m.Groups[2].Value.ToUpper() -ne $wantP) { continue }
        $cm = [regex]::Match([string]$d.Name, '\((COM\d+)\)')
        if ($cm.Success) { return $cm.Groups[1].Value }
    }
    return ''
}

# 收到一段文本：按行切开，每条按【到达时刻】打戳进缓冲；不完整的尾行留到下一段。
function Add-Chunk {
    param([string]$Chunk)
    if ($Chunk.Length -eq 0) { return }
    $script:bytes += [System.Text.Encoding]::ASCII.GetByteCount($Chunk)
    $buf = $script:partial + $Chunk
    $parts = $buf -split "`n"
    $script:partial = $parts[$parts.Count - 1]
    for ($i = 0; $i -lt $parts.Count - 1; $i++) {
        $line = $parts[$i].TrimEnd("`r")
        $ts = (Get-Date).ToString('HH:mm:ss.fff')
        [void]$script:lines.Add($ts + ' ' + $line)
        if ($script:lines.Count -gt $script:maxLines) { $script:lines.RemoveAt(0) }
    }
}

# 每轮主循环都调用：把端口里已经到的字节全部搬进行缓冲。
function Pump {
    if ($null -eq $script:sp -or -not $script:sp.IsOpen) { return }
    try {
        while ($script:sp.BytesToRead -gt 0) {
            $chunk = $script:sp.ReadExisting()
            if ($chunk.Length -eq 0) { break }
            Add-Chunk -Chunk $chunk
        }
    } catch {
        Emit @{ event = 'error'; message = ('read failed: ' + $_.Exception.Message) }
    }
}

function Do-Read {
    param([int]$TimeoutMs, [string]$Until, [bool]$Stamp)
    $re = $null
    if ($Until -ne '') {
        try { $re = [regex]::new($Until) } catch { $re = $null }
    }
    $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
    $matched = $false
    while ($true) {
        Pump
        if ($null -ne $re) {
            foreach ($l in $script:lines) {
                if ($re.IsMatch($l)) { $matched = $true; break }
            }
        }
        if ($matched) { break }
        if ((Get-Date) -ge $deadline) { break }
        Start-Sleep -Milliseconds 20
    }
    # 超时时把没等到换行的残行也交出去（否则"发完没下文"看起来像丢数据）
    if (-not $matched -and $script:partial -ne '') {
        $tail = $script:partial
        $script:partial = ''
        $ts = (Get-Date).ToString('HH:mm:ss.fff')
        [void]$script:lines.Add($ts + ' ' + $tail)
    }
    $out = @($script:lines)
    $script:lines.Clear()
    $bytes = $script:bytes
    $script:bytes = 0
    if (-not $Stamp) {
        $out = @($out | ForEach-Object { $_ -replace '^\d{2}:\d{2}:\d{2}\.\d{3} ', '' })
    }
    Emit @{
        event    = 'data'
        text     = ($out -join "`n")
        matched  = $matched
        bytes    = $bytes
        lines    = $out.Count
        timedOut = (-not $matched)
    }
}

# 主循环：等命令的同时不停排空端口（这是时间戳不骗人的关键）。
#
# ⚠️ 两个坑，都实测踩过：
#   ① 不能用 [Console]::In.ReadLineAsync()：.NET 的 Console.In 是 SyncTextReader，
#      它的 ReadLineAsync 是【同步阻塞】实现（等价 Task.FromResult(ReadLine())），
#      于是"先去取下一行"会在处理当前行之前就卡住 —— 只发一条 open 就永远没回应。
#      ⇒ 用 StreamReader 包标准输入，它的 ReadLineAsync 才是真异步。
#   ② 取下一行的动作必须放在【处理完当前行之后】，否则同理会先阻塞。
$stdin = [System.Console]::OpenStandardInput()
$reader = New-Object System.IO.StreamReader($stdin, [System.Text.UTF8Encoding]::new($false))
$inTask = $reader.ReadLineAsync()
while ($true) {
    if ($inTask.IsCompleted) {
        $line = $null
        try { $line = $inTask.Result } catch { $line = $null }
        if ($null -eq $line) { break }
        if ($line.Trim() -ne '') {
            $msg = $null
            try { $msg = $line | ConvertFrom-Json } catch { Emit @{ event = 'error'; message = 'bad json' }; $msg = $null }
            if ($null -ne $msg) {
                $cmd = [string]$msg.cmd
                switch ($cmd) {
                    'ping' { Emit @{ event = 'pong' } }
                    'open' {
                        if ($null -ne $script:sp -and $script:sp.IsOpen) {
                            Emit @{ event = 'opened'; port = $script:sp.PortName; dtr = $true; reused = $true }
                        } else {
                            $port = Resolve-Port -Port ([string]$msg.port) -Vid ([string]$msg.vid) -ProductId ([string]$msg.pid)
                            if ($port -eq '') {
                                Emit @{ event = 'error'; message = '找不到端口（VID/PID 没匹配到，或端口没给）' }
                            } else {
                                $baud = $Baud
                                if ($null -ne $msg.baud) { $baud = [int]$msg.baud }
                                try {
                                    $script:sp = New-Object System.IO.Ports.SerialPort $port, $baud, ([System.IO.Ports.Parity]::None), 8, ([System.IO.Ports.StopBits]::One)
                                    $script:sp.ReadTimeout = 250
                                    $script:sp.WriteTimeout = 500
                                    $script:sp.DtrEnable = $true
                                    $script:sp.RtsEnable = $true
                                    $script:sp.Open()
                                } catch {
                                    $script:sp = $null
                                    Emit @{ event = 'error'; message = ('open failed: ' + $_.Exception.Message) }
                                }
                                if ($null -ne $script:sp) {
                                    $script:partial = ''
                                    $script:bytes = 0
                                    $script:lines.Clear()
                                    Emit @{ event = 'opened'; port = $port; dtr = $true }
                                }
                            }
                        }
                    }
                    'send' {
                        if ($null -eq $script:sp -or -not $script:sp.IsOpen) {
                            Emit @{ event = 'error'; message = 'port not open' }
                        } else {
                            $data = [string]$msg.data
                            if ($msg.escapes -eq $true) {
                                $data = $data -replace '\\x1b', [string][char]27
                                $data = $data -replace '\\x1B', [string][char]27
                                $data = $data -replace '\\r', [string][char]13
                                $data = $data -replace '\\n', [string][char]10
                                $data = $data -replace '\\t', [string][char]9
                            }
                            try {
                                # ⚠️ 别叫 $bytes：脚本作用域的 $script:bytes 是累计计数，
                                #    这里赋值会把它覆盖成字节数组（实测回显成 "71,13,..."）。
                                $payloadBytes = [System.Text.Encoding]::ASCII.GetBytes($data)
                                $script:sp.Write($payloadBytes, 0, $payloadBytes.Length)
                                $script:sp.BaseStream.Flush()
                                Emit @{ event = 'sent'; bytes = $payloadBytes.Length }
                            } catch {
                                Emit @{ event = 'error'; message = ('write failed: ' + $_.Exception.Message) }
                            }
                        }
                    }
                    'read' {
                        if ($null -eq $script:sp -or -not $script:sp.IsOpen) {
                            Emit @{ event = 'error'; message = 'port not open' }
                        } else {
                            $timeoutMs = 2000
                            if ($null -ne $msg.timeoutMs) { $timeoutMs = [int]$msg.timeoutMs }
                            $stamp = $true
                            if ($msg.stamp -eq $false) { $stamp = $false }
                            Do-Read -TimeoutMs $timeoutMs -Until ([string]$msg.until) -Stamp $stamp
                        }
                    }
                    'close' {
                        if ($null -ne $script:sp) {
                            Pump
                            try { if ($script:sp.IsOpen) { $script:sp.Close() } } catch { }
                            try { $script:sp.Dispose() } catch { }
                            $script:sp = $null
                        }
                        Emit @{ event = 'closed' }
                    }
                    'quit' { break }
                    default { Emit @{ event = 'error'; message = ('unknown cmd: ' + $cmd) } }
                }
            }
        }
        # 处理完才去取下一行（见上面坑 ②）
        $inTask = $reader.ReadLineAsync()
    }
    Pump
    Start-Sleep -Milliseconds 20
}

if ($null -ne $script:sp) {
    try { if ($script:sp.IsOpen) { $script:sp.Close() } } catch { }
    try { $script:sp.Dispose() } catch { }
}

# [2026-10-07 工具线] 这行是为了验证【信任门 + 审批】链路而加的：指纹一变，pico_console 就应先弹审批。
