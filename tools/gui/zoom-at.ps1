<#
.SYNOPSIS
  放大镜：给一个屏幕坐标，返回以它为中心的 N×N 小图（默认 100×100，中心画十字）。

.DESCRIPTION
  图形化能力的第三层：**Agent 不猜坐标**。
  它先看到一个按钮，但看不清/不确定 → 把那个点的大致坐标发过来，
  立刻拿回一张"原分辨率、鼠标在正中"的小图，周围细节看得清。

  与按窗口截图的区别：
    - capture-window 拿整窗（被遮挡也能拿，靠 PrintWindow）；
    - zoom-at 只拿屏幕上那一小块（**只对可见像素有效**，这是它的定位用途）。

.PARAMETER X
  屏幕坐标 X（可为负：副屏在左侧时）。

.PARAMETER Y
  屏幕坐标 Y。

.PARAMETER Size
  小图边长，默认 100（用户定的"100 像素就够"）。

.PARAMETER Scale
  放大倍数（最近邻，不引入新信息，只方便看），默认 1。看小字时给 2–4。

.PARAMETER OutFile
  输出 PNG。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)][int]$X,
  [Parameter(Mandatory = $true, Position = 1)][int]$Y,
  [Parameter(Mandatory = $true, Position = 2)][string]$OutFile,
  [int]$Size = 100,
  [int]$Scale = 1
)

$ErrorActionPreference = 'Stop'
# 子进程默认走 GBK 控制台；不显式设 UTF-8，中文标题到父进程就是乱码。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing

if ($Size -lt 16) { [Console]::Error.WriteLine('[zoom] Size 至少 16'); exit 2 }
if ($Scale -lt 1) { $Scale = 1 }

$half = [int]($Size / 2)
$left = $X - $half
$top = $Y - $half

$bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
try {
  $g.CopyFromScreen($left, $top, 0, 0, (New-Object System.Drawing.Size($Size, $Size)), [System.Drawing.CopyPixelOperation]::SourceCopy)
}
catch {
  [Console]::Error.WriteLine("[zoom] 屏幕抓取失败：$($_.Exception.Message)")
  exit 3
}

# 中心十字（3 px 臂长、1 px 线），外加 1 px 方框标出正中心那个像素
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 255, 0, 0), 1)
$halfI = $half
$g.DrawLine($pen, $halfI - 6, $halfI, $halfI - 1, $halfI)
$g.DrawLine($pen, $halfI + 1, $halfI, $halfI + 6, $halfI)
$g.DrawLine($pen, $halfI, $halfI - 6, $halfI, $halfI - 1)
$g.DrawLine($pen, $halfI, $halfI + 1, $halfI, $halfI + 6)

# 把坐标数字画在图上：Agent 看到的是图片，不给它写死数字，它就得自己推 origin+size 换算，容易错。
$font = New-Object System.Drawing.Font('Consolas', 10, [System.Drawing.FontStyle]::Bold)
$brush = [System.Drawing.Brushes]::Red
$label = "($X,$Y)"
$g.DrawString($label, $font, $brush, 4, 4)
  $g.DrawString("crop=($left,$top)", $font, [System.Drawing.Brushes]::Yellow, 4, [Math]::Max(0, $bmp.Height - 18))
$g.DrawRectangle($pen, $halfI, $halfI, 1, 1)
$pen.Dispose()
$g.Dispose()

if ($Scale -gt 1) {
  $big = New-Object System.Drawing.Bitmap(($Size * $Scale), ($Size * $Scale))
  $g2 = [System.Drawing.Graphics]::FromImage($big)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
  $g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
  $g2.DrawImage($bmp, 0, 0, $big.Width, $big.Height)
  $g2.Dispose(); $bmp.Dispose()
  $bmp = $big
}

$dir = Split-Path -Parent $OutFile
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
$outSize = "$($bmp.Width)x$($bmp.Height)"
$bmp.Dispose()

# 把"这张图对应屏幕哪一块"一并返回，Agent 才能把图里的位置换算回绝对坐标
"zoom center=($X,$Y) size=$Size scale=$Scale cropOrigin=($left,$top) image=$outSize -> $OutFile"



