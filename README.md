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
