# ============================================================================
#  uninstall-picophone-plugin.ps1
#
#  一键卸载「dsh-picophone」这个 DSH 插件包 —— 只撤销【它自己加进 profile 的东西】：
#     ①  profile package.json 的 dependencies["dsh-picophone"]
#     ②  profile package.json 的 dsh.profile.bundles 里的 "dsh-picophone"
#     ③  profile cordis.patch.yml 里的 `- id: picophone` 覆盖行
#     ④  profile node_modules\dsh-picophone 软链接（交给 pnpm remove 处理）
#
#  **不碰**：pnpm 本身、别的插件与依赖、项目源码（除非显式 -PurgeSource）、
#            _agents\ 空间、git 仓库、debug_logs。
#
#  用法：
#     pwsh -File uninstall-picophone-plugin.ps1              # 交互确认
#     pwsh -File uninstall-picophone-plugin.ps1 -Yes         # 不确认
#     pwsh -File uninstall-picophone-plugin.ps1 -DryRun      # 只看会删什么
#     pwsh -File uninstall-picophone-plugin.ps1 -Yes -PurgeSource   # 连源码目录一起删
# ============================================================================

[CmdletBinding()]
param(
    [string]$Profile = '',
    [string]$PackageName = 'dsh-picophone',
    [string]$RowId = 'picophone',
    [switch]$Yes,
    [switch]$DryRun,
    [switch]$PurgeSource
)

$ErrorActionPreference = 'Stop'

function Say    { param($m) Write-Host $m }
function OkMsg  { param($m) Write-Host "  [OK]   $m" -ForegroundColor Green }
function WarnMsg{ param($m) Write-Host "  [警告] $m" -ForegroundColor Yellow }
function BadMsg { param($m) Write-Host "  [失败] $m" -ForegroundColor Red }
function Step   { param($m) Write-Host "`n== $m" }

# ---------------------------------------------------------------- 定位 profile

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
if ([string]::IsNullOrWhiteSpace($Profile)) {
    $Profile = if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'web' }
}
$profileDir = Join-Path $dshHome (Join-Path 'profiles' $Profile)
$pkgJsonPath = Join-Path $profileDir 'package.json'
$patchYmlPath = Join-Path $profileDir 'cordis.patch.yml'

Say 'dsh-picophone 卸载器 —— 只撤销这个插件加进去的东西'
Say "  DSH_HOME   : $dshHome"
Say "  profile    : $Profile"
Say "  profile 目录: $profileDir"

if (-not (Test-Path -LiteralPath $pkgJsonPath)) {
    BadMsg "找不到 $pkgJsonPath；profile 名或 DSH_HOME 不对，什么都没做。"
    exit 1
}

# ---------------------------------------------------------------- 盘点现状

Step '盘点：这个插件在 profile 里留下了什么'

$pkgJson = Get-Content -LiteralPath $pkgJsonPath -Raw -Encoding utf8 | ConvertFrom-Json

$depSpec = $null
if ($pkgJson.PSObject.Properties.Name -contains 'dependencies' -and $pkgJson.dependencies) {
    $depProp = $pkgJson.dependencies.PSObject.Properties[$PackageName]
    if ($depProp) { $depSpec = [string]$depProp.Value }
}

$bundleList = @()
if ($pkgJson.dsh -and $pkgJson.dsh.profile -and $pkgJson.dsh.profile.bundles) {
    $bundleList = @($pkgJson.dsh.profile.bundles)
}
$inBundles = $bundleList -contains $PackageName

$patchLines = @()
$patchHasRow = $false
if (Test-Path -LiteralPath $patchYmlPath) {
    $patchLines = @(Get-Content -LiteralPath $patchYmlPath -Encoding utf8)
    $patchHasRow = [bool]($patchLines | Where-Object { $_ -match ('^- id:\s*' + [regex]::Escape($RowId) + '\s*$') })
}

$linkPath = Join-Path (Join-Path $profileDir 'node_modules') $PackageName
$linkExists = Test-Path -LiteralPath $linkPath

Say "  ① 依赖        : $(if ($depSpec) { "$PackageName -> $depSpec" } else { '(没有)' })"
Say "  ② bundles 列表: $(if ($inBundles) { "含 $PackageName" } else { '(没有)' })"
Say "  ③ patch 覆盖行: $(if ($patchHasRow) { "- id: $RowId" } else { '(没有)' })"
Say "  ④ node_modules: $(if ($linkExists) { $linkPath } else { '(没有)' })"

if (-not $depSpec -and -not $inBundles -and -not $patchHasRow -and -not $linkExists) {
    Say ''
    OkMsg 'profile 里没有这个插件的任何痕迹，无需卸载。'
    exit 0
}

Say ''
Say '本脚本只动上面这 4 处；**不碰 pnpm、不碰别的插件与依赖、不碰项目源码与 git 仓库**。'
if ($PurgeSource) { WarnMsg '已指定 -PurgeSource：源码目录也会被删除。' }

# ---------------------------------------------------------------- 确认

if ($DryRun) {
    Say ''
    Say '[DryRun] 只盘点，不修改任何文件。'
    exit 0
}

if (-not $Yes) {
    Say ''
    $answer = Read-Host "确认卸载 $PackageName 吗？(输入 y 继续，其它键取消)"
    if ($answer -ne 'y' -and $answer -ne 'Y') {
        Say '已取消，什么都没改。'
        exit 0
    }
}

# ---------------------------------------------------------------- 备份

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Step '备份 profile 配置'
foreach ($file in @($pkgJsonPath, $patchYmlPath)) {
    if (Test-Path -LiteralPath $file) {
        $backup = "$file.bak-$stamp"
        Copy-Item -LiteralPath $file -Destination $backup -Force
        OkMsg "备份 $([System.IO.Path]::GetFileName($file)) -> $([System.IO.Path]::GetFileName($backup))"
    }
}

# ---------------------------------------------------------------- 移除依赖

Step '移除依赖（只 remove 这一个包）'
$dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
$pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
$removedByPkg = $false

if ($dshCmd) {
    Say "  dsh plugin --profile $Profile remove $PackageName"
    & dsh plugin --profile $Profile remove $PackageName
    $removedByPkg = ($LASTEXITCODE -eq 0)
} elseif ($pnpmCmd) {
    Say "  pnpm --dir `"$profileDir`" remove $PackageName"
    & pnpm --dir $profileDir remove $PackageName
    $removedByPkg = ($LASTEXITCODE -eq 0)
} else {
    WarnMsg '本机既没有 dsh 也没有 pnpm，跳过包管理器这一步；下面只清理配置文件。'
}

if ($removedByPkg) { OkMsg '包管理器已移除依赖。' }
elseif ($dshCmd -or $pnpmCmd) { WarnMsg '包管理器这一步没成功（详见上面的输出）；配置文件仍会被清理。' }

# pnpm 对 link: 依赖有时只改 package.json、把软链接留在 node_modules 里 ⇒ 自己收尾。
$linkPath = Join-Path (Join-Path $profileDir 'node_modules') $PackageName
if (Test-Path -LiteralPath $linkPath) {
    $linkItem = Get-Item -LiteralPath $linkPath -Force
    if ($linkItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        try {
            # 只摘链接本身；recursive=$false 保证不会跟进到源码目录
            [System.IO.Directory]::Delete($linkPath, $false)
            OkMsg 'node_modules 里的软链接已摘除（源码目录未动）。'
        } catch {
            WarnMsg "摘除软链接失败：$($_.Exception.Message)"
        }
    } else {
        WarnMsg "node_modules\$PackageName 不是软链接而是实体目录，为安全起见没有删除：$linkPath"
    }
}

# ---------------------------------------------------------------- 清理 package.json

Step '清理 package.json（依赖 + bundles 列表）'
$pkgJson = Get-Content -LiteralPath $pkgJsonPath -Raw -Encoding utf8 | ConvertFrom-Json
$changedPkg = $false

if ($pkgJson.PSObject.Properties.Name -contains 'dependencies' -and $pkgJson.dependencies) {
    if ($pkgJson.dependencies.PSObject.Properties[$PackageName]) {
        $pkgJson.dependencies.PSObject.Properties.Remove($PackageName)
        $changedPkg = $true
        OkMsg "dependencies 里已移除 $PackageName"
    }
}

if ($pkgJson.dsh -and $pkgJson.dsh.profile -and $pkgJson.dsh.profile.bundles) {
    $kept = @($pkgJson.dsh.profile.bundles | Where-Object { $_ -ne $PackageName })
    if ($kept.Count -ne @($pkgJson.dsh.profile.bundles).Count) {
        $pkgJson.dsh.profile.bundles = $kept
        $changedPkg = $true
        OkMsg "bundles 列表里已移除 $PackageName（剩 $($kept.Count) 条：$($kept -join ', ')）"
    }
}

if ($changedPkg) {
    $json = $pkgJson | ConvertTo-Json -Depth 20
    [System.IO.File]::WriteAllText($pkgJsonPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    OkMsg 'package.json 已写回。'
} else {
    WarnMsg 'package.json 里已经没有它的条目，未改动。'
}

# ---------------------------------------------------------------- 清理 patch 行

Step "清理 cordis.patch.yml（- id: $RowId 覆盖行）"
if (-not (Test-Path -LiteralPath $patchYmlPath)) {
    WarnMsg '没有 cordis.patch.yml，跳过。'
} else {
    $lines = @(Get-Content -LiteralPath $patchYmlPath -Encoding utf8)
    $out = New-Object System.Collections.Generic.List[string]
    $removed = 0
    $i = 0
    while ($i -lt $lines.Count) {
        if ($lines[$i] -match ('^- id:\s*' + [regex]::Escape($RowId) + '\s*$')) {
            $i++
            while ($i -lt $lines.Count -and $lines[$i] -match '^\s+\S') { $i++ }
            $removed++
            continue
        }
        $out.Add($lines[$i])
        $i++
    }
    if ($removed -gt 0) {
        $text = ($out -join "`r`n") + "`r`n"
        [System.IO.File]::WriteAllText($patchYmlPath, $text, (New-Object System.Text.UTF8Encoding($false)))
        OkMsg "已删除 $removed 行覆盖项。"
    } else {
        WarnMsg '没有这个覆盖行，未改动。'
    }
}

# ---------------------------------------------------------------- 可选：删源码

if ($PurgeSource) {
    Step '删除源码目录'
    $sourceDir = $null
    if ($depSpec -and $depSpec -like 'link:*') {
        $sourceDir = $depSpec.Substring(5)
    }
    if (-not $sourceDir) { $sourceDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'dsh-plugins\dsh-picophone' }
    $sourceDir = [System.IO.Path]::GetFullPath($sourceDir)

    if ($sourceDir -eq [System.IO.Path]::GetFullPath($PSScriptRoot)) {
        WarnMsg "源码目录与本脚本同目录（$sourceDir），拒绝删除（会删掉脚本自己）。"
    } elseif (-not (Test-Path -LiteralPath $sourceDir)) {
        WarnMsg "源码目录不存在：$sourceDir"
    } else {
        Say "  将删除：$sourceDir"
        Remove-Item -LiteralPath $sourceDir -Recurse -Force
        OkMsg '源码目录已删除。'
    }
}

# ---------------------------------------------------------------- 复核

Step '复核'
$after = Get-Content -LiteralPath $pkgJsonPath -Raw -Encoding utf8 | ConvertFrom-Json
$stillDep = $false
if ($after.dependencies) { $stillDep = [bool]$after.dependencies.PSObject.Properties[$PackageName] }
$stillBundle = $false
if ($after.dsh -and $after.dsh.profile -and $after.dsh.profile.bundles) {
    $stillBundle = @($after.dsh.profile.bundles) -contains $PackageName
}
Say "  package.json 依赖  : $(if ($stillDep) { '仍在（见上面警告）' } else { '已清除' })"
Say "  bundles 列表       : $(if ($stillBundle) { '仍在（见上面警告）' } else { '已清除' })"
Say "  node_modules 链接  : $(if (Test-Path -LiteralPath $linkPath) { '仍在（包管理器那步没成功）' } else { '已清除' })"
Say "  配置备份           : package.json.bak-$stamp / cordis.patch.yml.bak-$stamp"

Say ''
Say '完成。提醒：DSH 正在运行的话，插件会一直挂到【下次重启】才彻底消失。'
if (-not $PurgeSource) {
    Say "源码仍在：$(Join-Path (Split-Path -Parent $PSScriptRoot) 'dsh-plugins\dsh-picophone')（要一起删就加 -PurgeSource）"
}
exit 0
