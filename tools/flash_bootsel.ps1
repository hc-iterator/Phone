# tools\flash_bootsel.ps1 —— 用 BOOTSEL（U 盘）方式刷固件，**不需要 SWD / 探针**
#
# 为什么单独写一个：2026-09-30 一整天 SWD 都不通（探针挂过、接线也查过），
# 而目标板的 BOOTSEL 一直可用 —— 这条路不依赖任何调试器。
#
# ── 关于 UF2 的格式（**不是猜的，来自 SDK 的 uf2.h**）──
#
#   SDK: src/common/pico_binary_info/include/pico/binary_info/uf2.h
#     e48bff56  RP2040_FAMILY_ID
#     e48bff57  ABSOLUTE_FAMILY_ID      ← 写"绝对地址"，分区表块用这个
#     e48bff58  DATA_FAMILY_ID
#     e48bff59  RP2350_ARM_S_FAMILY_ID
#     e48bff5a  RP2350_RISCV_FAMILY_ID
#     e48bff5b  RP2350_ARM_NS_FAMILY_ID
#   块头（每块 512 字节）：
#     0 magic0 / 4 magic1 / 8 flags / 12 targetAddr
#     / 16 payloadSize / 20 blockNo / 24 numBlocks / 28 familyID
#
#   ⚠️ RP2350 的 UF2【按 family 分成几组，各组 blockNo/numBlocks 各自独立】：
#      块 0      : family=e48bff57(ABSOLUTE)、addr=0x10ffff00、numBlocks=2      ← 分区表
#      块 1..679 : family=e48bff59(RP2350)  、addr=0x10000000 起、numBlocks=679  ← 固件
#   所以"块 0 的 numBlocks ≠ 文件块数"**是正常的**，不能拿它判"文件不完整"。
#
# ── ⚠️⚠️ PowerShell 的一个大坑（今天栽了两次，见 错题本-工具 错 15）──
#
#   **大于 Int32.MaxValue 的十六进制字面量在 PowerShell 里不能用。**
#   0x9E5D5157 会被 tokenizer 解析成 **-1638051497（负 Int32）**；
#   而 [uint32]0x9E5D5157 不但救不了，还会**抛异常**（负数转 UInt32 失败）。
#   ⇒ 本脚本一律用【小写十六进制字符串】比较，类型免疫。
#      比较：$m0.ToString('x8') -ne '0a324655'
#      分派：switch ($fam.ToString('x8')) { 'e48bff56' { ... } }
#
# 用法：
#   pwsh -NoProfile -File tools\flash_bootsel.ps1
#   pwsh -NoProfile -File tools\flash_bootsel.ps1 -Uf2 build\PicoPhone.uf2

param(
    [string]$Uf2 = "build\PicoPhone.uf2",
    [string]$LabelPattern = "RP2350|RPI-RP2",
    [int]$WaitSeconds = 20
)

$ErrorActionPreference = 'Continue'

# family / magic —— 用【字符串】，不用数值（见上面那个坑）
$MAGIC0, $MAGIC1 = '0a324655', '9e5d5157'
$FAM_RP2040     = 'e48bff56'
$FAM_ABSOLUTE   = 'e48bff57'
$FAM_DATA       = 'e48bff58'
$FAM_RP2350_S   = 'e48bff59'
$FAM_RP2350_RV  = 'e48bff5a'
$FAM_RP2350_NS  = 'e48bff5b'

function Get-BootselVolume {
    Get-Volume | Where-Object { $_.FileSystemLabel -match $LabelPattern -and $_.DriveLetter } |
        Select-Object -First 1
}

Write-Host "=== flash_bootsel ==="

# ---------- 0) 源文件：解析 + 按 family 分组校验 ----------
if (-not (Test-Path $Uf2)) { Write-Host "❌ 找不到固件: $Uf2"; exit 2 }
$b    = [System.IO.File]::ReadAllBytes((Resolve-Path $Uf2).Path)
$nblk = [math]::Floor($b.Length / 512)
Write-Host ("  固件: {0}  {1} 字节 = {2} 块" -f $Uf2, $b.Length, $nblk)

if (($b.Length % 512) -ne 0) { Write-Host "❌ 不是 512 的整数倍 ⇒ 很可能被截断"; exit 2 }

$groups = @{}     # family(hex字符串) -> @{ nums = hashtable; declMax; count }
$badBlock = 0
for ($i = 0; $i -lt $nblk; $i++) {
    $o = $i * 512
    $m0 = [BitConverter]::ToUInt32($b, $o).ToString('x8')
    $m1 = [BitConverter]::ToUInt32($b, $o + 4).ToString('x8')
    if ($m0 -ne $MAGIC0 -or $m1 -ne $MAGIC1) { $badBlock++; continue }

    $bn  = [int][BitConverter]::ToUInt32($b, $o + 20)
    $nb  = [int][BitConverter]::ToUInt32($b, $o + 24)
    $fam = [BitConverter]::ToUInt32($b, $o + 28).ToString('x8')

    if (-not $groups.ContainsKey($fam)) {
        $groups[$fam] = @{ nums = @{}; declMax = 0; count = 0 }
    }
    $groups[$fam].nums[$bn] = $true
    if ($nb -gt $groups[$fam].declMax) { $groups[$fam].declMax = $nb }
    $groups[$fam].count++
}
if ($badBlock -gt 0) { Write-Host "❌ 有 $badBlock 个块的魔数不对 ⇒ 文件损坏"; exit 2 }

Write-Host "  按 family 分组："
$familiesPresent = @()
foreach ($fam in $groups.Keys) {
    $familiesPresent += $fam
    $g    = $groups[$fam]
    $got  = $g.nums.Count
    $maxn = ($g.nums.Keys | Measure-Object -Maximum).Maximum
    $miss = 0
    for ($k = 0; $k -le $maxn; $k++) { if (-not $g.nums.ContainsKey($k)) { $miss++ } }
    $name = switch ($fam) {
        $FAM_RP2040    { 'RP2040' }
        $FAM_ABSOLUTE  { 'ABSOLUTE(分区表)' }
        $FAM_DATA      { 'DATA' }
        $FAM_RP2350_S  { 'RP2350-ARM-S' }
        $FAM_RP2350_RV { 'RP2350-RISC-V' }
        $FAM_RP2350_NS { 'RP2350-ARM-NS' }
        default        { "未知 $fam" }
    }
    # 顺序完整性【只对固件家族】强制。
    # ⚠️ 观察到的行为（不是文档）：ABSOLUTE(分区表)那组只有 1 块、却声明 numBlocks=2，
    #    所以不能拿"块数 == 声明数"去判它 —— 它只是"把 256 字节写到 0x10ffff00"。
    #    （上一版就是在这里误报了合法固件；结论有实测支撑，但仍属"观察"而非"规范"。）
    $isPayload = @($FAM_RP2040, $FAM_RP2350_S, $FAM_RP2350_RV, $FAM_RP2350_NS) -contains $fam
    $selfConsistent = ($got -eq $g.declMax -and $miss -eq 0 -and $maxn -eq ($g.declMax - 1))
    if (-not $isPayload) {
        $verdict = '（元数据块：照绝对地址原样写，不按顺序规则判）'
    } elseif ($selfConsistent) {
        $verdict = '✅ 自洽'
    } else {
        $verdict = '⚠️ 不自洽'
    }
    Write-Host ("    family {0} {1,-18} 块数={2} 声明={3} 编号0..{4} 缺={5}  {6}" -f `
        $fam, $name, $got, $g.declMax, $maxn, $miss, $verdict)
    if ($isPayload -and -not $selfConsistent) {
        Write-Host "❌ 固件家族的编号不完整 ⇒ bootloader 会一直等剩下的块"
        exit 2
    }
}

# ---------- 1) 找 BOOTSEL 盘 ----------
$vol = Get-BootselVolume
if (-not $vol) {
    Write-Host "❌ 没找到 BOOTSEL 盘（标签匹配 '$LabelPattern'）"
    Write-Host "   做法: 按住目标板的 BOOTSEL → 插 USB（或点一下 RUN）→ 松开"
    Write-Host "   成功会出现一个 U 盘: RP2350（RP2350 板）或 RPI-RP2（RP2040 板）"
    Write-Host "   注意: 【不是】COM 口。"
    exit 3
}
Write-Host "  找到盘: $($vol.DriveLetter):  标签=$($vol.FileSystemLabel)  文件系统=$($vol.FileSystem)"

# ---------- 2) ★family 必须匹配盘的类型★ ----------
if ($vol.FileSystemLabel -match 'RP2350') {
    $allowed = @($FAM_RP2350_S, $FAM_RP2350_RV, $FAM_RP2350_NS, $FAM_ABSOLUTE, $FAM_DATA)
} else {
    $allowed = @($FAM_RP2040, $FAM_ABSOLUTE, $FAM_DATA)
}
$unexpected = @($familiesPresent | Where-Object { $allowed -notcontains $_ })
if ($unexpected.Count -gt 0) {
    Write-Host ("❌ family 不匹配！盘是 '{0}'，但固件里有不属于它的 family: {1}" -f `
        $vol.FileSystemLabel, ($unexpected -join ', '))
    Write-Host "   ⇒ 这样写进去 bootloader 会【静静地不刷】，看起来像没生效。先换对的固件。"
    exit 4
}
Write-Host "  ✅ family 匹配 ⇒ 可以写"

# ---------- 3) 写 ----------
$dst = "$($vol.DriveLetter):\" + (Split-Path $Uf2 -Leaf)
Write-Host "  写 → $dst"
try {
    [System.IO.File]::WriteAllBytes($dst, $b)
    Write-Host "  WriteAllBytes 正常返回（少见：通常设备会先重启）"
} catch {
    Write-Host "  WriteAllBytes 抛异常 → 收到完整 UF2 后设备立刻重启，这是【预期】的："
    Write-Host "     $($_.Exception.Message)"
}

# ---------- 4) 查结果 ----------
Write-Host "  等待设备以新身份回来（最多 $WaitSeconds 秒）..."
$ok = $false
for ($i = 1; $i -le $WaitSeconds; $i++) {
    Start-Sleep -Seconds 1
    if (Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
        Where-Object { $_.InstanceId -match '2E8A&PID_0009|2E8A&PID_000C' }) {
        $ok = $true
        Write-Host "  ✅ 第 $i 秒看到 2E8A 设备回来了"
        break
    }
}

$vol2 = Get-BootselVolume
Write-Host ""
Write-Host "=== 结果 ==="
if ($vol2) {
    Write-Host "  ⚠️ BOOTSEL 盘【还在】($($vol2.DriveLetter):) ⇒ 固件没被接受，设备又进了 bootloader。"
    Write-Host "     可能：family 不对 / 文件不完整 / 板子的 BOOTSEL 被强行按住或短接。"
    exit 5
} elseif ($ok) {
    Write-Host "  ✅ BOOTSEL 盘消失了，设备以 2E8A 身份回来 ⇒ 刷写成功。"
    exit 0
} else {
    Write-Host "  盘消失了但没看到 2E8A 设备 ⇒ 可能刷成功但设备没枚举（USB 线/口问题）。"
    exit 6
}
