# dsh-plugins —— 本项目自用的 DSH 扩展

这个目录**不在 `DeepSeekCode\` 里面**，但它是主仓库 `DeepSeekCode` 的一个 **git worktree**，
挂在**孤儿分支 `dsh-plugins`** 上（历史与 `deepseek_bunch` 完全分开，互不污染）。

```powershell
# 在这个目录里就是普通 git 仓库用法
git log --oneline          # 只看到插件的历史
git diff
git status
# 它属于主仓库，所以：
git -C ..\DeepSeekCode worktree list     # 能看到两个工作树
```

> **为什么要独立分支**：插件是"harness 侧的扩展"，不是电路板工程的一部分。
> 但方案的最后一道防线押在"**插件源码可审**"上（见 `DeepSeekCode\台架接口沙箱化说明.md` §六），
> 所以它**必须进版本控制**（快照 ≠ 版本控制：不能 diff / blame / 回滚到某行）。
> 独立分支 = 能审、能回滚，又不把插件的噪声掺进主线的 `deepseek_bunch` 历史。

## 布局

| 路径 | 是什么 |
|---|---|
| `dsh-picophone\` | **主力插件**：9 个 `pico_*` 工具 + `/pico` 命令（台架：构建 / 烧写 / 串口 / SWD / %TEMP% / git / 脚本） |
| `dsh-sandbox-probe\` | **临时探针插件**：只为回答"插件提的沙箱策略被不被采纳"（验完卸掉/删掉） |
| `uninstall-picophone-plugin.cmd` / `.ps1` | 一键卸载器：只撤本插件加进 profile 的那 4 处 |
| `_backups\` | 动手前的快照（**已 gitignore**，不进版本库） |

## 装 / 卸

```powershell
# 装（在 DSH 里）：plugin_manager  install_bundle  target = <这个目录>\dsh-picophone
# 卸：双击 uninstall-picophone-plugin.cmd  （或 plugin_manager remove_bundle dsh-picophone）
```

## 🔴 改这里的东西，必须重启 DSH 才生效

插件模块代际是**进程级缓存**：`set_plugin` 关/开、`remove_bundle` + `install_bundle`、
甚至改 `package.json` 的 `exports` 指向别的入口文件 —— **都无效**，加载器仍 import 旧模块。
（2026-10-06/07 反复实测，见 `DeepSeekCode\台架接口沙箱化说明.md` §八。）
⇒ **攒着一起改**，别改一行验一行。

## 🔐 沙箱之外的脚本：哈希钉在工作区外（2026-10-07 红队突破后加）

**为什么**：沙箱只管得住"经沙箱出去"的命令；而 `pico_build` / `pico_serial` / `pico_console` / `pico_flash` /
`/pico swd` / `/pico procs` / `pico_status(proc_guard)` 这 7 处**豁免沙箱**，跑的都是**工作区里的脚本** ——
工作区恰恰是被沙箱关住的那个 Agent **唯一能写的地方** ⇒
"把 payload 写进 `tools\proc_guard.ps1`，再调一次 `pico_status`" 就是一条**不过沙箱**的任意代码执行。
（同源的已确认突破：`pico_serial.outFile` 收绝对路径 ⇒ 往桌面写了 258 B，已修。）

**做法**：这 8 个脚本的 SHA256 钉在**工作区之外**：
`<工作区的父目录>\_picophone_trust\trusted-scripts.json`
（默认 `C:\Users\Chen\Desktop\Pico\_picophone_trust\trusted-scripts.json` —— 沙箱里的 Agent 写不到那里）。
每次执行前核对：**不符就拒绝**，错误里给出现在值 / 登记值 / 人该敲什么。

**受管脚本（8 个）**：`tools\build.cmd`、`build_sub.ps1`、`serial.ps1`、`serial-session.ps1`、
`flash_bootsel.ps1`、`flash_backdoor.ps1`、`swd.ps1`、`proc_guard.ps1`。

### 流程 —— 人

```
/pico trust                     # 看状态：✓ 匹配 / ✗ 已变更 / · 未登记
/pico trust tools/build.cmd     # 改完脚本后，只重新登记这一个
/pico trust init                # 全部重新登记
```

> 登记入口**只挂在 `/pico` 命令上，故意不做成工具** —— 做成工具就等于"AI 能自己把恶意脚本登记掉"。

### 流程 —— AI（**后来的 AI 请先读这一段，别晕**）

1. 你**可以**改这些脚本（工作区里你有写权限），但改完**下一次调用会被拒绝**，报：
   ```
   ⛔ 拒绝执行【沙箱之外】的脚本：tools/proc_guard.ps1
      原因：已变更（登记之后又被改过）
      当前 sha256_16 = …        登记值 = …
      ⇒ 请人敲：/pico trust tools/proc_guard.ps1
   ```
   **这不是 bug，是设计**：这类脚本要碰设备/要跑 cmake，只能跑在沙箱外，所以它的内容必须是人认可过的。
2. **别试着绕过**：把清单配到工作区之内会被 `trustDirIsSafe()` 直接拒（清单必须在工作区之外）；
   改插件源码（`index.js`）要**重启 DSH 才生效**，而且会留在 `git diff` 里被看见 ✓
3. **想跑你自己新写的脚本？照旧** —— 走 `pico_run`（**沙箱内**），这层**不管**。
   被管的只有"必须跑在沙箱外"的那 8 个 ⇒ 灵活性一点没丢 ✓

### 第一次会遇到的坑

刚加这层时清单还不存在 ⇒ **所有沙箱外的 op 都会被拒**（fail-closed，故意的）。
人敲一次 `/pico trust init` 即恢复。

## 🙋 改脚本不用记命令了：**AI 申请 → 你点同意**（2026-10-07 起）

指纹不符时，插件会**弹一条审批**给会话（走 DSH 的 `approval` 服务）：**AI 发起、你点同意**，你不用敲任何命令。

| 你做什么 | 结果 |
|---|---|
| 点**同意** | 插件把新指纹写进工作区外的清单，并**在同一次调用里继续执行**（不用点第二次） |
| 点**拒绝 / 取消** | 保持拒绝（fail-closed），输出里会写明"审批结果：rejected/cancelled" |
| 什么都不点 / 策略是 `never` | `unavailable` ⇒ **保持拒绝**（不会偷偷放行） |

审批框里会写清：脚本路径、**旧指纹 → 新指纹**、文件位置，以及一句
`要看改了什么：git -C <repo> diff -- <文件>`（这 8 个脚本都在 git 里，改了什么一眼能看见）。
每次申请与结果 DSH 都会记账（会话日志里可查）。

> `/pico trust` 命令**仍然保留** —— 降级成"你想手动看一眼 / 手动盖章"的后门，不再是唯一入口。

### 排障线索（对接方看这里）

- 报 `审批服务不可用（ctx.approval 没拿到）` ⇒ 审批服务没注入（profile 里缺 `approval`）。
- 报 `拿不到发起审批所需的 agent` ⇒ 插件拿不到发起者身份 ⇒ **保持拒绝**（不会误放行），此时才需要回到 `/pico trust`。

### ✅ 已实测闭环（2026-10-07）

改 `serial-session.ps1` 一行注释 ⇒ 指纹不符 ⇒ 调 `pico_console open` ⇒ **审批框弹出** ⇒
点【拒绝】⇒ 输出 `审批结果：rejected`，**拒绝生效**（无崩溃、无漏锁）。
随后按备份把 worker **整文件恢复**到登记值 ⇒ 串口/console 路径无需再登记即恢复正常。

**教训 1（改受管脚本）**：不要用"文本替换"小修小补 —— `Add-Content`/替换会改**编码与行尾**，
哈希就变成 `61cd0560…` 这种对不上的值。要么**整文件恢复**（用 `_backups\` 里的备份），要么**重新登记**。

**教训 2（沙箱里推代码）**：用 `pico_git`（它自动带 openssl + 工作区里的 CA + 令牌 header）；
**裸 `git push` 在沙箱里必失败** —— schannel 要用户加密存储（`SEC_E_NO_CREDENTIALS`），
`sh.exe` 要命名管道（`couldn't create signal pipe`）。
