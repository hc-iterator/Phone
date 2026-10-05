<#
  sync_agent_spaces.ps1 —— 把主仓库的最新状态【同步】到 _agents\ 下的所有子智能体空间

  ── 为什么需要它（2026-10-05 实证）────────────────────────────────────────
  第三方只读报告 R3 实测：_agents\{dsflash,ernie,kimi,qwen} 仍是"本子→文档"改名
  【之前】的旧快照（根下还有 `引路本.md`、`docs/` 只有 6 份）。
  它们"已了解项目"的认知建立在**已不存在的路径**上 ⇒
  **按规矩 25 复用它们之前必须先同步**，否则它们会引用旧名、写出断链。

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
$branch = (& git -C $main rev-parse --abbrev-ref HEAD).Trim()
$mainHead = (& git -C $main rev-parse HEAD).Trim()

Write-Host "主仓库   : $main"
Write-Host "分支/HEAD: $branch / $($mainHead.Substring(0,8))"
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

    $b     = (& git -C $p rev-parse --abbrev-ref HEAD).Trim()
    $head  = (& git -C $p rev-parse HEAD).Trim()
    $dirty = (& git -C $p status --porcelain)
    $hasDirty = ($dirty | Where-Object { $_ -ne '' }).Count -gt 0
    $remotes  = (& git -C $p remote) | Where-Object { $_ -ne '' }
    $hasRemote = $remotes.Count -gt 0

    # 独有提交判据：本空间 HEAD 是否为主仓库 HEAD 的祖先
    & git -C $main merge-base --is-ancestor $head $mainHead 2>$null
    $isAncestor = ($LASTEXITCODE -eq 0)

    $action = '同步'; $reason = ''
    if ($hasRemote)            { $action = '跳过'; $reason = "有 remote: $($remotes -join ',')（安全边界）" }
    elseif ($hasDirty -and -not $Force) { $action = '跳过'; $reason = '有未提交改动' }
    elseif (-not $isAncestor)  { $action = '跳过'; $reason = '有独有提交（不能 reset）' }

    if ($action -eq '同步' -and -not $List) {
        & git -C $p fetch --quiet $main "${branch}:refs/heads/__sync_tmp" 2>$null
        if ($LASTEXITCODE -ne 0) { $action = '失败'; $reason = 'fetch 失败' }
        else {
            & git -C $p reset --hard --quiet __sync_tmp 2>$null
            if ($LASTEXITCODE -ne 0) { $action = '失败'; $reason = 'reset 失败' }
            else { & git -C $p update-ref -d refs/heads/__sync_tmp 2>$null }
        }
    }

    $newHead = (& git -C $p rev-parse HEAD).Trim()
    $hasTrap = Test-Path (Join-Path $p 'docs\陷阱.md')      # 同步成功的直观标志
    $rootMd  = (Get-ChildItem $p -File -Filter *.md | Measure-Object).Count

    $results += [pscustomobject]@{
        空间   = $name
        分支   = $b
        动作   = $action
        HEAD前 = $head.Substring(0,8)
        HEAD后 = $newHead.Substring(0,8)
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
    $r = (& git -C $d.FullName remote) | Where-Object { $_ -ne '' }
    $ok = if ($r.Count -eq 0) { 'OK 推不出去' } else { "XX $($r -join ',')" }
    "  {0,-10} {1}" -f $d.Name, $ok
}
