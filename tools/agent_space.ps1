<#
  agent_space.ps1 —— 给子智能体开辟一块【独立空间】（独立 git 仓库）

  为什么要独立：主 AI 只负责分配与合并，子智能体【不许有能力改主仓库】。
  本脚本做五件事：
    ① 从主仓库克隆一份到 <仓库父目录>\_agents\<名字>
    ② 摘掉 origin —— 物理上推不回主仓库
    ③ 建它自己的工作分支 agent/<名字>
    ④ 放一份 AGENT_SPACE_RULES.md（硬边界），并用 .git/info/exclude 挡住，不进提交
    ⑤ 在主仓库把它注册成只读来源（remote <名字>），合并方向单向

  用法：
    .\tools\agent_space.ps1 -Name kimi
    .\tools\agent_space.ps1 -Name ernie -Recreate
#>
param(
    [Parameter(Mandatory=$true)][string]$Name,
    [string]$BaseBranch = 'deepseek_bunch',
    [switch]$Recreate
)
$ErrorActionPreference = 'Stop'
$main   = Split-Path -Parent $PSScriptRoot
$parent = Split-Path -Parent $main
$dst    = Join-Path (Join-Path $parent '_agents') $Name

if (Test-Path $dst) {
    if (-not $Recreate) { Write-Host "已存在: $dst （要重建请加 -Recreate）" -ForegroundColor Yellow; exit 1 }
    Remove-Item $dst -Recurse -Force
}
New-Item -ItemType Directory -Force (Split-Path -Parent $dst) | Out-Null

git clone --quiet --branch $BaseBranch --single-branch $main $dst
git -C $dst remote remove origin
git -C $dst switch -q -c "agent/$Name"

Copy-Item (Join-Path $PSScriptRoot 'AGENT_SPACE_RULES.template.md') (Join-Path $dst 'AGENT_SPACE_RULES.md') -Force
Add-Content (Join-Path $dst '.git\info\exclude') "AGENT_SPACE_RULES.md"

Push-Location $main
if (((git remote) -join ',') -notmatch "(^|,)$Name(,|$)") { git remote add $Name $dst }
git fetch --quiet $Name
Pop-Location

Write-Host "已建空间: $dst" -ForegroundColor Green
Write-Host ("  分支   = " + (git -C $dst rev-parse --abbrev-ref HEAD))
$rm = ((git -C $dst remote) -join ',')
if ([string]::IsNullOrEmpty($rm)) { $rm = '(无 - 推不回主仓库)' }
Write-Host ("  remote = " + $rm)
Write-Host ("  HEAD   = " + (git -C $dst log --oneline -1))
