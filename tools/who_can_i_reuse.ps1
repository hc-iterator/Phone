<#
  who_can_i_reuse.ps1 —— 【派活第一件事】：先看有什么能复用的，再决定要不要新建

  ── 为什么有它（2026-10-05 用户两次纠正）────────────────────────────────
  用户原话："不是叫你复用吗！" -> "不是！是复用子智能体！"
  我当时的错：**新起了一个子智能体、还手搓了一个空间** ——
  而 `_agents\` 里本来就有"已了解项目"的智能体、`tools\agent_space.ps1` 本来就是建空间的工具 ✗。

  ⇒ 病根不是"忘了"，是**没先看清单**。
  ⇒ 治法是把它变成**一条命令**：派活前跑一次，清单摆在眼前。
     （我（AI）的上下文每个会话都会重置 —— **只有仓库里的东西能跨会话**，
      所以"记住"这件事只能靠**命令 / 模板 / 用户口令**，不能靠我"注意"。）

  ── 用法 ────────────────────────────────────────────────────────────────
    .\tools\who_can_i_reuse.ps1              # 列出所有可复用的空间与状态
    .\tools\who_can_i_reuse.ps1 -ShowMain    # 额外打印主仓库 HEAD（比对新鲜度）

  ── 配套口令（用户随时可用）────────────────────────────────────────────
    对 AI 说"**先给我复用清单**" ⇒ AI 必须跑本脚本并逐条说明"用哪个/为什么不用"。
#>
param([switch]$ShowMain)

$main   = Split-Path -Parent $PSScriptRoot
$parent = Split-Path -Parent $main
$agents = Join-Path $parent '_agents'

$branch = (& git -C $main rev-parse --abbrev-ref HEAD).Trim()
$head   = (& git -C $main rev-parse HEAD).Trim()
if ($ShowMain) {
    Write-Host "主仓库: $main"
    Write-Host "  分支=$branch  HEAD=$($head.Substring(0,8))"
    Write-Host ""
}

Write-Host "===== 可复用的子智能体空间（先看这里，再决定新建）=====" -ForegroundColor Green
if (-not (Test-Path $agents)) { Write-Host "  （没有 _agents 目录）"; exit 0 }

$rows = @()
foreach ($d in (Get-ChildItem $agents -Directory | Sort-Object Name)) {
    $p = $d.FullName
    if (-not (Test-Path (Join-Path $p '.git'))) {
        $rows += [pscustomobject]@{ 空间=$d.Name; 分支='-'; 新鲜='?'; 独有提交='?'; remote='?'; 说明='不是 git 仓库' }
        continue
    }
    $b    = (& git -C $p rev-parse --abbrev-ref HEAD).Trim()
    $h    = (& git -C $p rev-parse HEAD).Trim()
    $rm   = ((& git -C $p remote) | Where-Object { $_ -ne '' }) -join ','
    & git -C $main merge-base --is-ancestor $h $head 2>$null
    $isAnc = ($LASTEXITCODE -eq 0)
    $fresh = if ($h -eq $head) { '同步' } elseif ($isAnc) { '落后' } else { '分叉' }
    $dirty = ((& git -C $p status --porcelain) | Where-Object { $_ -ne '' }).Count
    $note  = if ($dirty -gt 0) { "有 $dirty 处未提交" } else { '工作树干净' }
    if ($rm -ne '') { $note += " ⚠ 有 remote($rm)" }
    $rows += [pscustomobject]@{
        空间      = $d.Name
        分支      = $b
        新鲜      = $fresh
        独有提交  = $(if ($isAnc) { '无（可安全同步）' } else { '有（别 reset！）' })
        remote    = $(if ($rm -eq '') { '空(推不出去 ✓)' } else { $rm })
        说明      = $note
    }
}
$rows | Format-Table -AutoSize

Write-Host "怎么用这份清单：" -ForegroundColor Cyan
Write-Host "  1) 【首选复用】挑一个 新鲜=同步 或 落后 的空间 ⇒ 跑 tools\sync_agent_spaces.ps1 -Only <名字> 同步，" 
Write-Host "     然后 send_message 给它派活（**别新建**）"
Write-Host "  2) 新鲜=分叉 或 独有提交=有 ⇒ 那个空间手上有活，别覆盖；要用就先看它的分支内容"
Write-Host "  3) 确实没有合适的 ⇒ 才用 tools\agent_space.ps1 -Name <新名字> 新建"
Write-Host "  4) 选模型前先看 docs\模型选择.md（用户规定：只用 V4Flash 与明显更便宜的）"
