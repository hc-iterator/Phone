<#
  sync_agent_spaces.ps1 —— 把主仓库的最新状态【同步】到 _agents\ 下的所有子智能体空间

  ── 为什么需要它（2026-10-05 实证）────────────────────────────────────────
  第三方只读报告 R3 实测：_agents\{dsflash,ernie,kimi,qwen} 仍是"本子→文档"改名
  【之前】的旧快照（根下还有 `引路本.md`、`docs/` 只有 6 份）。
  它们"已了解项目"的认知建立在**已不存在的路径**上 ⇒
  **按规矩 25 复用它们之前必须先同步**，否则它们会引用旧名、写出断链。

  ── 🗓 2026-10-07 改语法：沙箱内不再"捕获子进程输出" ─────────────────────
  症状（实测）：在沙箱里跑本脚本 ⇒ 满屏
      Program 'git.exe' failed to run: Access to the path
      '\\.\pipe\LOCAL\dotnet_…' is denied
  原因：PowerShell **只要捕获** native 命令的输出（`$x = & git …` / `2>$null` / `| Out-Null`），
        底层就走 .NET `Process` 的**匿名管道**（Windows 上实现为 `\\.\pipe\LOCAL\dotnet_*`）⇒ 沙箱一律拒 ✗
  改法（**项目里已有的正确手法**，见 `tools\build_sub.ps1:98`）：
        **让 `cmd` 自己做重定向落文件，PowerShell 只读文件** ✓
        · 取值：  cmd /c "git … > <临时文件> 2>&1"   然后 Get-Content 那个文件
        · 只要码：cmd /c "git … > nul 2>&1"          然后看 $LASTEXITCODE
        · 绝不写 `$x = (& exe …)` / `… | Out-Null` / `2>$null` —— 那三种都会建管道 ✗
  （同类仍在用的豁免脚本 `swd.ps1`/`serial.ps1`/`proc_guard.ps1` 保持 `RedirectStandardOutput` ✓ ——
    它们**本来就在沙箱外**执行 ✓ 且必须解析输出 ✓，别跟着改 ✗）

  ── 安全设计（默认"安全模式"，只同步合格的空间）────────────────────────
    ① 有【未提交改动】⇒ 跳过并报告（不覆盖别人手上的活）       可用 -Force 覆盖
    ② 有【独有提交】（HEAD 不是主仓库 HEAD 的祖先）⇒ 跳过并报告
       （例：_agents\doctidy 带着文档化专项的 3 个提交，绝不能 reset 掉）
    ③ 空间【不许有 remote】⇒ 有就报告并跳过（安全边界：子空间不该能推出去）
    ④ 同步用 `git fetch <主仓库路径>` + `reset --hard`，**不添加任何 remote**
       ⇒ 同步完成后它**依然推不出去** ✓

  ── 用法 ────────────────────────────────────────────────────────────────
    .\tools\sync_agent_spaces.ps1            安全模式：同步所有合格空间
    .\tools\sync_agent_spaces.ps1 -List      只体检（不动手）
    .\tools\sync_agent_spaces.ps1 -Force     未提交改动也照样 reset（危险）
    .\tools\sync_agent_spaces.ps1 -Only kimi 只处理指定空间
#>
param(
    [switch]$List,
    [switch]$Force,
    [string]$Only
)

$ErrorActionPreference = 'Continue'
$main   = Split-Path -Parent $PSScriptRoot          # DeepSeekCode（仓库根）
$parent = Split-Path -Parent $main                  # PicoPhone
$agents = Join-Path $parent '_agents'

# ---- 沙箱友好的取值辅助：cmd 落文件 + 读文件（绝不在 PowerShell 里捕获 native 输出）----
# ⚠️ 临时文件名不要加引号：路径里没有空格，而 cmd /c "… > \"f\" …" 的嵌套引号是经典坑 ✗
$script:TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh_sync_' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $script:TmpDir -Force | Out-Null
$script:TmpN = 0

# ---- ⚠️ 前置探测：沙箱内本脚本【无法工作】，要大声报错、绝不静默出假结果 ----
#   机理（2026-10-07 实测）：
#     · PowerShell 用 `& exe` / `$() ` / `|` / `cmd /c …` 启动 **native 进程**时，都会建 stdio 管道
#       （Windows 上是 `\\.\pipe\LOCAL\dotnet_*`）⇒ 沙箱的受限令牌**开不了这个管道** ⇒ 一律
#       `Program 'xxx' failed to run: Access to the path '\\.\pipe\LOCAL\dotnet_…' is denied` ✗
#       —— 注意：**连 `cmd /c` 也一样**，所以"改用 cmd 做重定向"救不了它 ✗（我试过 ✗）
#     · 能用的只有 **`Start-Process` 且不请求任何 `-Redirect*`**（不建管道 ⇒ 子进程继承句柄 ✓）
#       重定向交给 cmd 自己写文件 ✓，PowerShell 只读文件 ✓
#     · 所以：**本脚本要在沙箱外运行**（人侧直接 pwsh -File，或把它纳入豁免类）✓
#   为什么必须先探测：git 全失败时，后面所有判据都会翻转成假值（例如"有独有提交"、remote 栏假 OK）✗
$probeFile = Join-Path $script:TmpDir 'probe_git.txt'
$probeProc = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', ('git --version > ' + $probeFile + ' 2>&1')) -NoNewWindow -Wait -PassThru
$probeText = ''
if (Test-Path $probeFile) { $probeText = ((Get-Content $probeFile -Raw -ErrorAction SilentlyContinue) + '') }
if ([string]::IsNullOrWhiteSpace($probeText)) {
    Write-Host ""
    Write-Host "✗ 起不了 git（本脚本很可能正跑在【沙箱】里）" -ForegroundColor Red
    Write-Host "  沙箱内 PowerShell 无法启动 native 进程：它要建命名管道（\\.\pipe\LOCAL\dotnet_*），受限令牌开不了 ✗" -ForegroundColor Red
    Write-Host "  ⇒ 请在【沙箱外】运行本脚本（人侧直接 pwsh -File tools\sync_agent_spaces.ps1），或把它纳入豁免类 ✓" -ForegroundColor Red
    Write-Host "  （已主动退出：宁可失败，也不给出一份「git 全没跑成」的假报告 ✗）" -ForegroundColor Red
    try { Remove-Item $script:TmpDir -Recurse -Force -ErrorAction SilentlyContinue } catch { }
    exit 2
}

function Invoke-GitToFile {
    param([string]$Repo, [string[]]$GitArgs)
    $script:TmpN++
    $f = Join-Path $script:TmpDir ("o{0}.txt" -f $script:TmpN)
    $line = 'git -C "' + $Repo + '" ' + ($GitArgs -join ' ') + ' > ' + $f + ' 2>&1'
    # ⚠️ 只许 Start-Process（不请求 -Redirect* ⇒ 不建管道 ✓）；重定向交给 cmd 自己写文件 ✓
    $p = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', $line) -NoNewWindow -Wait -PassThru
    $text = ''
    if (Test-Path $f) { $text = ((Get-Content $f -Raw -ErrorAction SilentlyContinue) + '') }
    $script:LastGitCode = $(if ($null -ne $p) { $p.ExitCode } else { $null })
    return $text.Trim()
}

function Invoke-GitToNul {
    param([string]$Repo, [string[]]$GitArgs)
    $line = 'git -C "' + $Repo + '" ' + ($GitArgs -join ' ') + ' > nul 2>&1'
    $p = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', $line) -NoNewWindow -Wait -PassThru
    return $(if ($null -ne $p) { $p.ExitCode } else { 1 })   # 起不来一律当"非 0"，别当成功 ✗
}

$branch   = Invoke-GitToFile -Repo $main -GitArgs @('rev-parse','--abbrev-ref','HEAD')
$mainHead = Invoke-GitToFile -Repo $main -GitArgs @('rev-parse','HEAD')

Write-Host "主仓库   : $main"
Write-Host "分支/HEAD: $branch / $(if ($mainHead.Length -ge 8) { $mainHead.Substring(0,8) } else { $mainHead })"
Write-Host "空间目录 : $agents"
if ($List) { Write-Host "模式     : 只体检（-List）" -ForegroundColor Yellow }
else       { Write-Host "模式     : 同步（安全模式）" -ForegroundColor Cyan }
Write-Host ""

if (-not (Test-Path $agents)) { Write-Host "找不到 _agents 目录" -ForegroundColor Red; exit 1 }

$results = @()
foreach ($d in (Get-ChildItem $agents -Directory | Sort-Object Name)) {
    $name = $d.Name
    if ($Only -and $name -ne $Only) { continue }
    $p = $d.FullName
    if (-not (Test-Path (Join-Path $p '.git'))) {
        $results += [pscustomobject]@{ 空间=$name; 分支='-'; 动作='跳过'; 原因='不是 git 仓库' }
        continue
    }

    $b        = Invoke-GitToFile -Repo $p -GitArgs @('rev-parse','--abbrev-ref','HEAD')
    $head     = Invoke-GitToFile -Repo $p -GitArgs @('rev-parse','HEAD')
    $dirtyTxt = Invoke-GitToFile -Repo $p -GitArgs @('status','--porcelain')
    $hasDirty = ($dirtyTxt -split "`r?`n" | Where-Object { $_ -ne '' }).Count -gt 0
    $remTxt   = Invoke-GitToFile -Repo $p -GitArgs @('remote')
    $remotes  = @($remTxt -split "`r?`n" | Where-Object { $_ -ne '' })
    $hasRemote = $remotes.Count -gt 0

    # 独有提交判据：本空间 HEAD 是否为主仓库 HEAD 的祖先（只要退出码）
    $isAncestor = ((Invoke-GitToNul -Repo $main -GitArgs @('merge-base','--is-ancestor',$head,$mainHead)) -eq 0)

    $action = '同步'; $reason = ''
    if ($hasRemote)                      { $action = '跳过'; $reason = "有 remote: $($remotes -join ',')（安全边界）" }
    elseif ($hasDirty -and -not $Force)  { $action = '跳过'; $reason = '有未提交改动' }
    elseif (-not $isAncestor)            { $action = '跳过'; $reason = '有独有提交（不能 reset）' }

    if ($action -eq '同步' -and -not $List) {
        $code = Invoke-GitToNul -Repo $p -GitArgs @('fetch','--quiet',$main,"${branch}:refs/heads/__sync_tmp")
        if ($code -ne 0) { $action = '失败'; $reason = 'fetch 失败' }
        else {
            $code = Invoke-GitToNul -Repo $p -GitArgs @('reset','--hard','--quiet','__sync_tmp')
            if ($code -ne 0) { $action = '失败'; $reason = 'reset 失败' }
            else { [void](Invoke-GitToNul -Repo $p -GitArgs @('update-ref','-d','refs/heads/__sync_tmp')) }
        }
    }

    $newHead = Invoke-GitToFile -Repo $p -GitArgs @('rev-parse','HEAD')
    $hasTrap = Test-Path (Join-Path $p 'docs\陷阱.md')      # 同步成功的直观标志
    $rootMd  = (Get-ChildItem $p -File -Filter *.md | Measure-Object).Count

    $results += [pscustomobject]@{
        空间   = $name
        分支   = $b
        动作   = $action
        HEAD前 = $(if ($head.Length -ge 8) { $head.Substring(0,8) } else { $head })
        HEAD后 = $(if ($newHead.Length -ge 8) { $newHead.Substring(0,8) } else { $newHead })
        '根.md' = $rootMd
        'docs/陷阱.md' = $(if ($hasTrap) { '有' } else { '无' })
        原因   = $reason
    }
}

Write-Host "===== 结果 =====" -ForegroundColor Green
$results | Format-Table -AutoSize
Write-Host "图例：动作=同步(已对齐主仓库) / 跳过(见原因) / 失败 ; 'docs/陷阱.md=有' 表示已带改名后的文档体系"

# 同步后复查：所有空间的 remote 必须仍为空（安全边界）
Write-Host ""
Write-Host "===== 安全复查：空间 remote 必须为空 =====" -ForegroundColor Green
foreach ($d in (Get-ChildItem $agents -Directory | Sort-Object Name)) {
    if ($Only -and $d.Name -ne $Only) { continue }
    if (-not (Test-Path (Join-Path $d.FullName '.git'))) { continue }
    $rTxt = Invoke-GitToFile -Repo $d.FullName -GitArgs @('remote')
    $r = @($rTxt -split "`r?`n" | Where-Object { $_ -ne '' })
    $ok = if ($r.Count -eq 0) { 'OK 推不出去' } else { "XX $($r -join ',')" }
    "  {0,-10} {1}" -f $d.Name, $ok
}

# 清掉本次的临时文件（里面只是 git 的输出）
try { Remove-Item $script:TmpDir -Recurse -Force -ErrorAction SilentlyContinue } catch { }
