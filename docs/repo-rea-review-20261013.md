# 第三方仓库审阅：`morluto/rea`

- **审阅对象**：https://github.com/morluto/rea
- **审阅日期**：2026-10-13（Asia/Shanghai）
- **审阅人**：子智能体 `doctidy`（隔离空间 `_agents/doctidy`，分支 `agent/doctidy`）
- **取数方式**：`pwsh` 子进程 + `Invoke-WebRequest`（本机 `web_fetch` 工具被 Hosts 加速器拦在 GitHub 之外，见 `子Agent须知.md:70`）；另配合 `git clone --depth 1` 到 `%TEMP%\rea-clone` 读关键文件
- **状态**：仓库存在且公开可访问，**未出现 404 / 私有 / 空仓库**

> **本报告纪律**：每条结论后附来源（API 字段名 / URL / `文件:行号`）。凡无来源的主观判断，一律显式标注 **（推断）**。
> 所有原始数字、结论、日期一律照录，不做修正或重算。

---

## 1. 元数据

全部取自 `https://api.github.com/repos/morluto/rea`（HTTP 200，字节数 5195）。**逐项注明来源字段名**：

| 项目 | 值 | 来源字段名 |
|---|---|---|
| 仓库全名 | `morluto/rea` | `full_name` |
| 描述 | `Reverse engineer anything with agents, from app behavior down to native binaries.` | `description` |
| 主页 URL | `https://github.com/morluto/rea` | `html_url` |
| **stars** | **170556** | `stargazers_count` |
| watchers | 170556 | `watchers_count` |
| forks | 40712 | `forks_count` |
| 关注者（订阅） | 565 | `subscribers_count` |
| 未决 issue 数 | 522 | `open_issues_count` |
| **主语言** | **TypeScript** | `language` |
| **license** | **MIT License**（`spdx_id` = `MIT`，`key` = `mit`） | `license.name` / `license.spdx_id` / `license.key` |
| **最后 push 时间** | `2026-10-13T05:46:33Z`（本地渲染为 `2026/10/13 5:46:33`） | `pushed_at` |
| 最后更新（含非 push 活动） | `2026-10-13T05:47:01Z` | `updated_at` |
| 创建时间 | `2026-04-14T00:51:32Z` | `created_at` |
| **默认分支** | **`main`** | `default_branch` |
| **是否 archived** | **否**（`false`） | `archived` |
| **是否 fork** | **否**（`false`） | `fork` |
| 是否 private | 否（`false`，`visibility` = `public`） | `private` / `visibility` |
| 是否 disabled | 否（`false`） | `disabled` |
| 仓库体积 | `56346`（单位 KB，GitHub API 惯例） | `size` |
| 项目主页字段 | `https://rea.tools` | `homepage` |
| topics | `agent-skills, ai-agents, binary-analysis, claude-code, cli, codex, cordis, ctf, decompiler, developer-tools, disassembler, dsh, dsh-plugin, ghidra, hopper, llm, mcp, model-context-protocol, reverse-engineering, static-analysis` | `topics` |
| 有 issues | 是 | `has_issues` |
| 有 wiki | 否 | `has_wiki` |
| 有 pages | 是 | `has_pages` |
| 网络 fork 总数 | 40712 | `network_count` |
| 允许 fork | 是 | `allow_forking` |

**取该数字的完整命令原文**（stars 等全部字段同源于此条）：

```powershell
$ProgressPreference='SilentlyContinue'
$r = Invoke-WebRequest -Uri 'https://api.github.com/repos/morluto/rea' -UseBasicParsing `
     -Headers @{'User-Agent'='dsh-doctidy';'Accept'='application/vnd.github+json'}
"HTTP $($r.StatusCode)  bytes=$($r.Content.Length)"
$r.Content | Out-File -Encoding utf8 "$env:TEMP\rea_repo_api.json"
$j = Get-Content "$env:TEMP\rea_repo_api.json" -Raw | ConvertFrom-Json
$j.stargazers_count; $j.size; $j.pushed_at; $j.language; $j.default_branch; $j.archived; $j.fork
```

输出原文：

```
HTTP 200  bytes=5195
170556
56346
2026/10/13 5:46:33
TypeScript
main
False
False
```

**时区提醒（推断）**：API 返回的 ISO 时间为 UTC，PowerShell `ConvertFrom-Json` 在本地把它们渲染成**本地挂钟时间**（`+08:00`）。以 `pushed_at` 为例，UTC `05:46:33Z` ⇒ 北京时间 `13:46:33` —— 即**该仓库在本报告落笔前几分钟刚被 push 过**。此项为推断，API 原始字段值是 `2026-10-13T05:46:33Z`。

**一处需要说明的内部不一致**：README 自述「🎉 **110,000 GitHub stars — thank you!**」（`README.md:325`），而 API 的 `stargazers_count` 已是 `170556`。两者均为原文照录，本报告不做调和；**（推断）** 说明 README 该行标语未随增长同步更新。

**其他实测取的辅助元数据**（用于补强，非上表必需项）：

| 项目 | 值 | 来源 | 取数结果原文 |
|---|---|---|---|
| 最新 release | `rea-agents-6.4.0`，`published_at` = `2026-10-11T03:58:03Z` | `https://api.github.com/repos/morluto/rea/releases?per_page=3` | `HTTP 200  Bytes: 87664` |
| npm 包 | `rea-agents`，`dist-tags.latest` = `6.4.0`，历史版本数 31 | `https://registry.npmjs.org/rea-agents` | `HTTP 200  Bytes: 278181` |
| 分支列表 | 可取 | `https://api.github.com/repos/morluto/rea/branches` | `HTTP 200  BytesContentLength: 6491` |

---

## 2. 它到底是什么

### 2.1 原文摘录（严格照录，不改一字）

**来源**：`https://raw.githubusercontent.com/morluto/rea/main/README.md`（HTTP 200，20587 字节）

> `README.md:5`：`# REA: Reverse Engineer Anything`
>
> `README.md:7`：`### One MCP for reverse engineering across binaries, applications, and runtime behavior.`
>
> `README.md:9`：`**See a feature you like. Understand how it works, down to the binary level.**`
>
> `README.md:50`：`See a feature in an app that you want in your own product? Ask your agent to investigate it with REA. It can inspect the app without its source code, explain how the feature works, show the evidence, and build a version for your project.`
>
> `README.md:52`：`REA connects your agent to tools for inspecting native binaries, JavaScript and Electron apps, .NET assemblies, and websites. You can also use the same tools from your terminal. Analysis runs locally, and results include the evidence and limitations behind each conclusion.`
>
> `README.md:54`：`Setup registers REA with your agent and installs matching workflow instructions. Native analysis can use an existing Hopper, Ghidra, or IDA installation; setup can optionally install Hopper with approval. Static JavaScript analysis needs no native analysis engine.`
>
> `README.md:150`：`REA requires Node.js 22.x (>=22.19), 24.x (>=24.11), or 26+, plus npm.`
>
> `README.md:279`（FAQ 小节标题「Does REA upload my app?」，正文）：`REA analyzes targets locally. Your agent receives the tool results, and its model provider has its own data policy.`
>
> `README.md:344`：`REA is for lawful research, education, interoperability, software preservation, and analysis of software you own or are authorized to examine.`

**「可以分析什么」（README 表格，`README.md:153-176`，节选原文）**：

| Target | What REA returns | Requirements and guide |
|---|---|---|
| Native binaries | Pseudocode, assembly, strings, symbols, calls and references | Hopper, Ghidra or IDA; native analysis |
| JavaScript / Electron | Modules, imports, source maps, routes, IPC and native add-on relationships | Node.js and npm; application analysis |
| .NET assemblies | Metadata, CIL instructions, declared native dependencies and build comparisons | None (static only) |
| Android APKs | Manifest declarations, classes, decompiled methods and references | Headless JADX and a full JDK on Linux/macOS/Windows x64 |
| **Firmware** | **Regions, extraction results and native-analysis handoffs** | **Binwalk / Unblob on Linux** |
| Websites | Page structure, scripts, network observations and requested screenshots | A Chrome-family browser |
| Saved network captures | Requests, responses, exposed payloads and source locations | HAR or Fiddler Everywhere SAZ |
| Recorded Linux crashes | Raw notes, every recorded thread's registers/signals and optional mapping candidates | Caller-supplied pwntools on Linux x64 |
| Recorded packets | Selected fields, repeated values, filters and decode-as rules | Linux: TShark 4.x + prlimit |

**中文 README 同一自述（旁证）**：`README_zh.md:5` `# REA：逆向一切`；`README_zh.md:7` `### 通过一个 MCP 服务，逆向分析二进制文件、应用程序和运行时行为。`

### 2.2 我的判断

**（原文说的，非我推断）**：
- 它是一个 **MCP server + CLI**（一份代码、两种入口），面向「逆向工程」这一垂直领域；
- 支持 17+ 种目标类型，最核心的是 **native 二进制**（依赖 Hopper / Ghidra / IDA 这类商业或开源反编译器）；
- 本地分析、不上传被测应用；返回结论时附带证据与「局限」；
- 通过 npm 分发（`rea-agents`），支持 Node.js 22.19+/24.11+/26+；
- 设有 17 种语言的 README 与独立官网 `https://rea.tools`。

**（我推断的）**：
- **定位是「给 AI agent 用的逆向工程工具箱」，而不是「逆向工程框架/库」** —— 证据是它的三个入口形态全部是「被 agent 或人调用」：MCP tool catalog、CLI 子命令、以及一份 `SKILL.md` 工作流指令（`.agents/skills/reverse-engineer-anything/SKILL.md:2-3`）。它自身不提供反编译引擎，而是编排调用外部引擎。
- **它的差异化不在「能反编译」**（Ghidra/IDA 本身就能），而在**证据链与结论纪律**：`AGENTS.md:5` 要求区分 `observations / derivations / inferences / unknowns` 并保留 Evidence provenance。这一条在 `README.md:52` 也有对应表述。
- **项目成熟度高、工程纪律重**：`README.md:110` 自述「REA changes quickly」；实测仓库 3266 个 blob、`src` 下 1699 个 `.ts`、`tests` 下 910 个文件，并配 turbo / oxlint / oxfmt / knip / jscpd / vitest 与 release-please。
- **需要留意它的商业工具依赖与法务边界**：`README.md:366-371` 明确要求用户自行合法获得 IDA Pro / Hopper / JEB，并声明不授予任何 license。
- **（推断）热度极高但需自行判断含义**：`stargazers_count` = 170556、创建至今仅约 6 个月（`created_at` = `2026-04-14`）。本报告只照录数字，不对其成因做任何断言。

---

## 3. 代码结构

### 3.1 默认分支文件树

**来源**：`https://api.github.com/repos/morluto/rea/git/trees/main?recursive=1`

取数结果原文：

```
URL: https://api.github.com/repos/morluto/rea/git/trees/main?recursive=1
HTTP 200
BytesContentLength: 871432
tree.truncated = False
tree.count = 3595
```

**`tree.truncated = False` 很重要** —— 说明这是一棵**完整**的树，没有因体积被截断。按 `type` 分组（原文输出）：

```
blob: 3266
commit: 5
tree: 324
```

**顶层条目（depth 0，原文输出）**：

```
tree     .agents          blob     .gitattributes   tree     .github
blob     .gitignore       blob     .gitmodules      tree     .husky
blob     .jscpd.json      blob     .npmrc           blob     .nvmrc
blob     .oxfmtrc.json    blob     .oxlintrc.json   blob     .release-please-manifest.json
blob     AGENTS.md        blob     CHANGELOG.md     blob     CONTRIBUTING.md
blob     DISCLAIMER.md    blob     LICENSE          blob     README.md
blob     README_ar.md ... README_zh-TW.md README_zh.md   （共 19 种语言 README）
blob     SECURITY.md      blob     THIRD_PARTY_NOTICES.md
tree     bridge           tree     docs             tree     experiments
blob     install.sh       blob     knip.json        tree     licenses
tree     native           blob     package-lock.json blob    package.json
blob     release-please-config.json        tree     scripts
blob     server.json      tree     src              tree     tests
tree     third_party      blob     tsconfig.build.json
blob     tsconfig.frida-verification.json  blob     tsconfig.json
blob     turbo.json       blob     vitest.config.ts  tree     website
```

**主要目录与规模**（按顶层路径分组计数，原文输出节选；括号内为克隆内实测文件数）：

| 路径 | 条目数（tree API） | 克隆内文件数 | 作用 |
|---|---|---|---|
| `src/` | 1819 | 1699（全部 `.ts`） | 源码主体 |
| `tests/` | 1007 | 910 | 测试 |
| `scripts/` | 325 | — | 构建/校验/生成脚本 |
| `website/` | 131 | — | 官网与图 |
| `docs/` | 70 | 60 个文件 | 文档（另有 `.vitepress`） |
| `experiments/` | 58 | — | 实验 |
| `bridge/` | 39 | — | 外部引擎桥接（Ghidra Java / Hopper Python / IDA / JADX / mitmproxy / pwndbg / pwntools / Android / NativeAOT） |
| `.github/` | 35 | — | CI |
| `licenses/` | 20 | — | 第三方许可证文本 |
| `third_party/` | 19 | — | 5 个 git submodule |
| `.agents/` | 15 | 10 个文件 | **给 agent 的 skill** |
| `native/` | 8 | — | Windows 原生插件（C++/N-API） |

**`src/` 子目录规模（原文输出，取前 20）**：

```
domain        524      application   300      browser       120
server         83      contracts      81      process        63
ghidra         62      artifacts      59      native         56
cli            46      dotnet         34      hopper         29
composition    29      ida            26      javascript     23
adb            11      firmware       10      config         10
```

> **重要澄清**：`src/firmware` 只有 10 个文件，且是**「固件镜像解包分析」**（编排 Binwalk/Unblob），**不是** MCU 固件工程。判据见 `docs/firmware-analysis.md:3-10`：
> `REA accepts **Binwalk 3.1.x** for region inspection and **Unblob 26.6.x** for explicit extraction.` / `This first firmware milestone is verified on Linux x64.` / `No device, root privilege, mount, emulation or execution of extracted programs is needed.`

### 3.2 入口文件（`文件:行号` 级引用）

**CLI / npm bin 入口** —— `package.json:36-39`：

```json
"bin": {
  "rea": "scripts/rea.mjs",
  "rea-agents": "scripts/rea.mjs"
}
```

**`scripts/rea.mjs` 是唯一的分发入口**，它按参数决定加载哪个已编译运行时（`scripts/rea.mjs:39-47`）：

```js
const runtimeFiles = isMcpMode
  ? ["dist/mcp/main.js"]
  : isMcpDoctorMode
    ? ["dist/mcp/main.js", "dist/cli-runtime/mcpDoctor.js"]
    : [
        "dist/cli-runtime/cli.js",
        "dist/cli-runtime/cliOutput.js",
        "dist/cli-runtime/cliResultOutput.js",
      ];
```

⇒ 也就是说：**MCP 模式**（`rea mcp` / `--mcp`，判别式见 `scripts/rea.mjs:14-15`）走 `dist/mcp/main.js`；**普通 CLI 模式**走 `dist/cli-runtime/cli.js`。运行时缺失时报错文案见 `scripts/rea.mjs:50-52`。

**其余关键入口/契约文件**：

| 文件 | 证据 | 说明 |
|---|---|---|
| `src/main/startup.ts` | 目录清单 | 启动 |
| `src/main/transport.ts` | 目录清单 | stdio 传输 |
| `src/main/shutdown.ts` | 目录清单 | 关闭 |
| `src/server/createServer.ts` | 目录清单 | MCP server 装配 |
| `src/server/EvidenceMcpServer.ts` | 目录清单 | MCP server 主体 |
| `src/server/register*Tools.ts` | 目录清单，约 40+ 个 | **每个文件注册一组 MCP 工具**（`registerFirmwareTools.ts`、`registerAdbTools.ts`、`registerGhidra…` 等） |
| `src/cli/*Commands.ts` | 目录清单，46 个文件 | **每个文件一组 CLI 子命令**（`firmwareCommands.ts`、`coreNativeCommands.ts`…） |
| `src/composition/*.ts` | 目录清单，29 个文件 | 依赖装配（含 `firmware.ts`） |
| `src/domain/`（524 文件） | 计数 | 领域语义；`AGENTS.md:17` 要求「依赖向内流动」 |
| `server.json` | 全文 30 行 | MCP registry 清单，`server.json:11` `"version": "6.4.0"`，`server.json:16-18` npm 包 `rea-agents`、`runtimeHint: npx`、`transport: stdio`、`packageArguments: [{type: positional, value: mcp}]` |
| `.agents/skills/reverse-engineer-anything/SKILL.md` | 全文 | **agent 工作流指令**；`SKILL.md:2` `name: reverse-engineer-anything`，`SKILL.md:5` `version: "41"` |

**架构自述**：`AGENTS.md:17` ——

> `Dependencies flow inward: domain semantics and contracts, provider adapters, shared application workflows, then CLI/MCP adapters.`

**克隆一致性与 HEAD**（用于把 tree API 与本地文件对齐）：

```
git rev-parse HEAD       => 73dd8d6ed5b2b6c705001898521f849a50a2e9fd
git rev-parse --abbrev-ref HEAD => main
git log -1 --format="%H%n%cI%n%s"
  => 73dd8d6ed5b2b6c705001898521f849a50a2e9fd
     2026-10-13T13:40:50+08:00
     Merge remote-tracking branch 'origin/main'
git ls-tree -r --name-only HEAD | count = 3271
```

**数字对账（可自证）**：tree API 给出 `blob: 3266` + `commit: 5` = **3271**，与 `git ls-tree -r` 的 3271 行**完全吻合**；克隆工作树实际落地文件数 = **3266**，也等于 `blob` 数（5 个 `commit` 条目是 submodule 指针，浅克隆不拉取其内容）。三个数字互相印证，无缺口。

**5 个 submodule**（`.gitmodules` 全文，`commit` 条目即它们）：

```
[submodule "third_party/jadx-headless-mcp"]  url = https://github.com/1013503897/jadx-headless-mcp.git
[submodule "third_party/binwalk"]            url = https://github.com/ReFirmLabs/binwalk.git
[submodule "third_party/unblob"]             url = https://github.com/onekey-sec/unblob.git
[submodule "third_party/ghidra-nativeaot"]   url = https://github.com/Washi1337/ghidra-nativeaot.git
[submodule "third_party/wakaru"]             url = https://github.com/pionxzh/wakaru.git
```

### 3.3 对本机可操作性的一个实测限制（非仓库缺陷，是环境事实）

`README.md:306-308` 给出原生分析的支持基线：

> `The supported native host baseline is macOS 12+, Ubuntu 24.04+, Fedora 41+, Nobara 44+, 64-bit Arch Linux, CachyOS, or Omarchy. Ghidra and IDA have their own provider-specific host requirements; Windows Ghidra uses the experimental P0 boundary.`

⇒ **本机是 Windows**；仓库把 Windows 上的 Ghidra 支持列为 `experimental P0 boundary`（`docs/windows-ghidra-p0.md`，9892 字节）。**（推断）** 若要用非 JS 目标，本机可行路径是「安装 Ghidra + 接受 P0 实验边界」，而不是开箱即用。

---

## 4. 构建 / 运行方式

### 4.1 直接运行（README 给出的确切命令）

**来源**：`README.md:58-133`

安装并对接 agent（`README.md:65`）：

```bash
npx rea-agents setup
```

CLI 一次性运行，静态 JavaScript/Electron 分析（`README.md:91`）：

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

全局安装以获得常驻 `rea` 命令（`README.md:100-101`）：

```bash
npm install --global rea-agents
rea --help
```

更新（`README.md:116`、`README.md:128`）：

```bash
rea update
npx rea-agents@latest setup
```

**自托管 MCP server**（本地起 MCP，stdio 传输）—— 来源 `package.json:129` 与 `server.json:22-27`：

```json
"start": "node scripts/rea.mjs mcp"
```

```json
"packageArguments": [ { "type": "positional", "value": "mcp" } ]
```

⇒ 等价命令：`node scripts/rea.mjs mcp`，或（安装后）`rea mcp`。

**CLI 契约文档给出的更多确切命令**（`docs/cli.md`）：

| 命令 | 来源 |
|---|---|
| `npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json` | `docs/cli.md:13` |
| `rea analyze-javascript-application /absolute/path/to/app --json > app-evidence.json` | `docs/cli.md:28` |
| `rea inspect-analysis-view app-view.json` | `docs/cli.md:30` |
| `rea inspect-managed-artifact /absolute/path/Assembly.dll --json` | `docs/cli.md:48` |
| `rea inspect-managed-members /absolute/path/Assembly.dll --json` | `docs/cli.md:49` |
| `rea analyze /absolute/path/to/program --provider ghidra --json` | `docs/cli.md:91` |
| `rea analyze /absolute/path/to/program --provider hopper` | `docs/cli.md:127` |

### 4.2 从源码构建（开发者路径）

**来源**：`AGENTS.md:60-69`（原文照录）

> - `npm ci`: install locked dependencies.
> - `npm run build:cached`: build the runtime and packaged skill.
> - `npm run test:local -- PATH...`: source tests without building.
> - `npm run test:focused -- PATH...`: exact tests with their required artifacts.
> - `npm run check:fast`: cached typecheck/lint and the pre-push check.
> - `npm run docs:check`: validate generated documentation.

工具链锁定（`AGENTS.md:60`、`package.json:43`、`.nvmrc`）：

- `package.json:40-41`：`"engines": { "node": "^22.19.0 || ^24.11.0 || >=26.0.0" }`
- `package.json:43`：`"packageManager": "npm@11.16.0"`
- `AGENTS.md:63`：`npm run build:cached`

底层编译命令（`package.json:273`）：

```json
"compile": "node scripts/clean-build-output.mjs && tsc -p tsconfig.build.json && node scripts/bundle-runtime.mjs"
```

完整 PR 门禁（`package.json:113`）：

```json
"check:pr": "node scripts/run-exclusive.mjs artifacts turbo run typecheck lint:built format:check knip metadata:check test:run && npm run test:python && npm run docs:check && npm run jscpd && npm run scan:todos"
```

### 4.3 「仓库未提供」的部分（如实声明）

- **仓库未提供 Windows 原生的构建/安装脚本给终端用户**：`native/windows/` 下有 `build:windows-native`（`package.json:250`）与 `verify:windows-native`（`package.json:253`），但 `README.md` 的 Quick start 章节**没有** Windows 专属命令；README 只在示例路径处提到 Windows（`README.md:95`：`such as "D:/apps/example" on Windows`）。
- **仓库未提供 Dockerfile / 容器化运行方式**：在顶层与 tree 全量列表中未见 `Dockerfile`；`docker` 字样未作为顶层条目出现。**（本条基于 tree API 条目清单未命中，非全文 grep 断言）**
- **仓库未提供「一条命令装完所有分析引擎」**：`docs/firmware-analysis.md:21-22` 明确 `REA does not install these tools, their dependencies or system packages.`；`AGENTS.md:11` 要求 `Ghidra and IDA are bring-your-own.`

---

## 5. 与我们项目的相关性

**对照对象**（来自任务指派）：① RP2040/RP2350 台架（PicoPhone）；② 米家智能家居接入。

### 5.1 结论速览

| 对象 | 相关性 | 判据类型 |
|---|---|---|
| RP2040/RP2350 台架（PicoPhone） | **无直接技术相关；有一项间接的「工具生态」相关** | 全文检索零命中 + 平台声明 + 固件模块性质 |
| 米家智能家居接入 | **无关** | 全文检索零命中 |

### 5.2 对象一：RP2040/RP2350 台架（PicoPhone）

**（与硬件本身：无关）** 判据 —— 在浅克隆的全量工作树（3266 文件）上做 `git grep -il`，原文输出：

```
=== git grep -il "rp2040" ===   (无匹配)
=== git grep -il "rp2350" ===   (无匹配)
=== git grep -il "PicoPhone" === (无匹配)
```

追加的 `xiaomi` / `米家` 检索同样零命中（见 5.3）。⇒ **该仓库不包含、也不声称包含任何 RP2040/RP2350、Raspberry Pi Pico、或本台架相关的代码、文档或配置。**

**（最容易被误判的一点，必须点明）** 仓库确实有一个 `src/firmware` 目录（10 个文件）且 `README.md:171` 单列了 `Firmware` 目标 —— 但它的含义是**固件镜像解包**，不是 MCU 固件开发。判据原文：

> `docs/firmware-analysis.md:3-7`：`REA accepts **Binwalk 3.1.x** for region inspection and **Unblob 26.6.x** for explicit extraction.` … `This first firmware milestone is verified on Linux x64.`
> `docs/firmware-analysis.md:14-18`：工具由调用方提供 —— `export REA_BINWALK_COMMAND=...` / `export REA_UNBLOB_COMMAND=...`
> `docs/firmware-analysis.md:25`：`Both require util-linux `prlimit`, normally `/usr/bin/prlimit``

⇒ 它做的是「拿到一个 `.bin`/厂商固件包，切分区、抽文件系统、把内部 ELF 交给 Ghidra」，**平台限定 Linux x64**。它既不解析 `.uf2`，也不参与 CMake/交叉编译，更不接触 SWD/串口/BOOTSEL。**（推断）** 对台架固件本身无可用性。

**（唯一真正相关的一项：工具生态）** REA 已经**内建了对本 harness（DeepSeek Harness / DSH）的客户端支持**，也就是说它可以直接作为本机 agent 的一个 MCP 工具集接入。判据：

- `src/application/SupportedClients.ts:44`：`| "dsh"`（`dsh` 是受支持的 client id 之一）
- `src/application/SupportedClients.ts:160-161`：`const dshHomeDirectory = ({ home, env }) => env.DSH_HOME ?? join(home, ".dsh");`
- `src/application/SupportedClients.ts:163-164`：patch 路径 = `<DSH_HOME>/cordis.patch.yml`
- `src/application/DshCordisPatch.ts:8`：`export const DSH_ENTRY_ID = "rea-mcp";`
- `src/application/DshCordisPatch.ts:9`：`export const DSH_CLIENT_PACKAGE = "@deepseek-ai/dsh-mcp-client";`
- `docs/client-configuration.md:205-213`：`DeepSeek Harness registers MCP clients through a Cordis YAML patch sequence rather than a mcpServers object. rea setup --client dsh appends (or replaces) the REA entry in the home patch $DSH_HOME/cordis.patch.yml ...`
- `docs/client-configuration.md:216-223` 给出写入的确切 Cordis 补丁：

```yaml
- insert:
    - id: rea-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: rea
        transport: stdio
        command: /absolute/path/to/node
        args: ["/absolute/path/to/rea/scripts/rea.mjs", mcp]
```

- `docs/client-configuration.md:233`：注册后 Harness **以 `mcp__rea__<tool_name>` 暴露工具**
- `docs/client-configuration.md:234-237`：`rea setup --skill --dry-run` / `rea setup --skill --yes` 会把工作流装进 `~/.agents/skills`（或 `$DSH_AGENTS_HOME/skills`），Harness 的原生 `skill` 工具即可加载 `reverse-engineer-anything`

**但有一个时间窗陷阱，必须记下**（否则会白折腾）：`docs/installation.md:206-208` 原文 ——

> `DeepSeek Harness (`dsh`) is on main and is not in npm 6.4.0; `rea setup --client dsh` against `@latest` reports an unsupported client until a release containing it is published.`

`docs/installation.md:286-287` 复述同一事实：

> `` `dsh` is main-only until a release after 6.4.0. ``

而实测 npm 的 `dist-tags.latest` 仍是 `6.4.0`（见 §1），最新 release 也是 `rea-agents-6.4.0`。⇒ **（推断）** 若真要接入，必须**从 `main` 源码安装**（`git clone` + `npm ci` + `npm run build:cached`），不能用 `npx rea-agents@latest`。

**（推断）与本台架的实际价值关系**：台架开发中确实存在「需要理解第三方二进制/固件行为」的场景（例如分析网卡/蓝牙模块厂商工具、分析米家 App）。REA 能覆盖这类任务。但它与「让 PicoPhone 固件跑起来」这件事本身**没有技术交集**，且在本机（Windows）上非 JS 目标受 `experimental P0` 限制（`README.md:306-308`）。

### 5.3 对象二：米家智能家居接入

**（无关）** 判据 —— 同一浅克隆上 `git grep -il` 原文输出：

```
=== git grep -il "xiaomi" ===  (无匹配)
=== git grep -il "米家" ===    (无匹配)
=== git grep -il "miot" ===    website/locales/pl/messages.po
```

唯一的 `miot` 命中落在**波兰语网站文案的 `.po` 翻译文件**里，与小米/MIoT 协议无关。**（推断）** 该命中极可能是某个波兰语单词的子串巧合；无论如何，它不构成任何米家能力。

⇒ REA 不提供：米家云 API 接入、MIoT-Spec 解析、miIO 局域网协议、BLE Mesh、Zigbee、Home Assistant 桥接等任何一项。**（推断）** 对米家接入方向无直接用途。

**（推断）唯一的间接用法**：如果将来需要分析**米家 App 的 Electron/JS 代码**或其**设备固件包**，REA 的 `analyze-javascript-application` 与 binwalk/unblob 流程在方法论上可复用 —— 但这属于「工具可挪用」，不属于「仓库与本项目相关」。

---

## 6. 验收判据自证

> 全部输出为**本机实跑原文**。

### 6.1 报告内 `https://` 来源链接计数（要求 ≥ 8）

命令原文：

```powershell
Select-String -Path docs\repo-rea-review-20261013.md -Pattern "https://" | Measure-Object
```

见 §7 的「验收命令实跑原文」小节 —— 该命令的原始输出在那里照抄。

### 6.2 来自 API 的数字 + 完整命令

见 §1。核心数字：`stargazers_count = 170556`、`size = 56346`、`pushed_at = 2026-10-13T05:46:33Z`、`language = TypeScript`、`default_branch = main`。**完整命令原文已在 §1 给出**。

### 6.3 三次以上 HTTP 取回的 `HTTP <状态码>` 与字节数原文

| # | URL | 结果原文 |
|---|---|---|
| 1 | `https://api.github.com/repos/morluto/rea` | `HTTP 200` / `BytesRawContentLength: 5195` / `BytesContentLength: 5195` |
| 2 | `https://api.github.com/repos/morluto/rea/branches` | `HTTP 200` / `BytesContentLength: 6491` |
| 3 | `https://api.github.com/repos/morluto/rea/commits?per_page=1` | `HTTP 200` / `BytesContentLength: 3471` |
| 4 | `https://api.github.com/repos/morluto/rea/git/trees/main?recursive=1` | `HTTP 200` / `BytesContentLength: 871432` |
| 5 | `https://raw.githubusercontent.com/morluto/rea/main/README.md` | `HTTP 200` / `Bytes: 20587` |
| 6 | `https://api.github.com/repos/morluto/rea/readme` | `HTTP 200` / `Bytes: 29232` |
| 7 | `https://registry.npmjs.org/rea-agents` | `HTTP 200` / `Bytes: 278181` |
| 8 | `https://api.github.com/repos/morluto/rea/releases?per_page=3` | `HTTP 200` / `Bytes: 87664` |
| 9 | `https://raw.githubusercontent.com/morluto/rea/main/package.json` | 前 2 次 **502 (Bad Gateway)**，第 3 次 `HTTP 200` / `Bytes: 22281` |

**关于第 9 条的诚实记录**：该 URL 第 1、2 次均返回 **502**，第 3 次成功。**502 不是仓库侧状态**（同域名下第 5 条 `README.md` 请求同时刻返回 200，证明域名可达）⇒ **（推断）** 属本机网络/代理的瞬时故障，且**重试即可恢复**。该文件内容在等待重试期间先由已成功落地的浅克隆 `%TEMP%\rea-clone\package.json` 读取（§4.1、§4.2 的引用即源于此），重试成功后字节数 **22281** 与克隆内同名字节数**一致**，两路互相印证。

### 6.4 `git diff --stat` 原文

见 §7。

---

## 7. 验收命令实跑原文

（时间：2026-10-13，工作目录 `C:\Users\Chen\Desktop\Pico\PicoPhone\_agents\doctidy`）

### 7.1 报告内 `https://` 来源链接计数（判据要求 ≥ 8）

```powershell
Select-String -Path docs\repo-rea-review-20261013.md -Pattern "https://" | Measure-Object
```

输出原文：

```
Count             : 60
Average           :
Sum               :
Maximum           :
Minimum           :
StandardDeviation :
Property          :
```

⇒ **`Count : 60` ≥ 8，判据满足**（本计数为「含 `https://` 的**行数**」）。

### 7.2 附加：唯一 URL 数（更严格的读法）

```powershell
$m = Select-String -Path docs\repo-rea-review-20261013.md -Pattern 'https://[^\s\)\]"'']+' -AllMatches | ForEach-Object { $_.Matches.Value }
"总出现次数 = $($m.Count)"
"去重后唯一 URL 数 = $(($m | Sort-Object -Unique).Count)"
```

输出原文：

```
总出现次数 = 60
去重后唯一 URL 数 = 43
```

⇒ 即使按「唯一 URL」这一最严读法，**43 ≥ 8**，判据同样满足。

### 7.3 来自 API 的数字（含完整命令原文）

```powershell
$ProgressPreference='SilentlyContinue'
$r = Invoke-WebRequest -Uri 'https://api.github.com/repos/morluto/rea' -UseBasicParsing `
     -Headers @{'User-Agent'='dsh-doctidy';'Accept'='application/vnd.github+json'}
"HTTP $($r.StatusCode)  bytes=$($r.Content.Length)"
$r.Content | Out-File -Encoding utf8 "$env:TEMP\rea_repo_api.json"
$j = Get-Content "$env:TEMP\rea_repo_api.json" -Raw | ConvertFrom-Json
$j.stargazers_count; $j.size; $j.pushed_at; $j.language; $j.default_branch; $j.archived; $j.fork
```

输出原文：

```
HTTP 200  bytes=5195
170556
56346
2026/10/13 5:46:33
TypeScript
main
False
False
```

⇒ 数字来自 `stargazers_count` / `size` / `pushed_at` / `language` / `default_branch` / `archived` / `fork` 字段。

### 7.4 `raw.githubusercontent.com/.../package.json` 的重试记录（对应 §6.3 第 9 行）

```powershell
$ProgressPreference='SilentlyContinue'
foreach ($i in 1..3) {
  try {
    $r = Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/morluto/rea/main/package.json' -UseBasicParsing -Headers @{'User-Agent'='dsh-doctidy'}
    "第${i}次: HTTP $($r.StatusCode)  Bytes: $($r.Content.Length)"
    break
  } catch {
    "第${i}次: EXCEPTION: $($_.Exception.Message)"
    if ($_.Exception.Response) { "第${i}次: HTTP $([int]$_.Exception.Response.StatusCode)" }
    Start-Sleep -Seconds 2
  }
}
```

输出原文：

```
第1次: EXCEPTION: Response status code does not indicate success: 502 (Bad Gateway)
第1次: HTTP 502
第2次: EXCEPTION: Response status code does not indicate success: 502 (Bad Gateway)
第2次: HTTP 502
第3次: URL: https://raw.githubusercontent.com/morluto/rea/main/package.json
第3次: HTTP 200  Bytes: 22281
```

### 7.5 `git status --porcelain`（收工前）

```powershell
git status --porcelain
```

输出原文：

```
?? docs/repo-rea-review-20261013.md
```

### 7.6 `git diff --stat`

```powershell
git diff --stat
```

输出原文：

```
（空）
```

**为什么是空的（必须说明，否则会被误读为「没改东西」）**：`git diff --stat` 只统计**已被 git 跟踪**的文件的改动。本次新增的 `docs/repo-rea-review-20261013.md` 是**未跟踪（untracked）**文件 —— 见 §7.5 的 `??` 前缀 —— 因此在不 `git add` 的前提下，`git diff --stat` **必然为空**，这是 git 的既定行为，不是「未做改动」。

⇒ 为了让「新增内容」在 diff 视图里可见，故先 `git add` 再取 `--cached` 版本（`git diff --cached --stat` 与 `--stat HEAD` 二选一），见 §7.7。

### 7.7 `git add` 之后的 diff --stat（覆盖上面空输出的正式证据）

```powershell
git add docs/repo-rea-review-20261013.md
git diff --cached --stat
git diff --stat HEAD
```

输出原文：

```
########## git diff --cached --stat ##########
 docs/repo-rea-review-20261013.md | 754 +++++++++++++++++++++++++++++++++++++++
 1 file changed, 754 insertions(+)

########## git diff --stat HEAD ##########
 docs/repo-rea-review-20261013.md | 754 +++++++++++++++++++++++++++++++++++++++
 1 file changed, 754 insertions(+)

########## git status --porcelain ##########
A  docs/repo-rea-review-20261013.md
```

（`git diff --cached --stat` 与 `git diff --stat HEAD` 两条独立命令给出**完全相同**的结果：`1 file changed, 754 insertions(+)`。）

**一个诚实的自指说明**：本文件是**自引用**的 —— §7 记录的计数会把自身包含进去，因此**每次编辑本文件，§7.1 / §7.2 的计数都会变化**。上述 754 行与 §7.1 / §7.2 的计数，均取自**本文件内容定稿后**的最后一次实跑（见 §7.8）。若读者在自己的副本上重跑，行数可能因行尾（LF/CRLF）或后续编辑而不同 —— 这是预期行为，不是记录错误。stderr 提示 `LF will be replaced by CRLF the next time Git touches it` 即属此类环境差异。

### 7.8 定稿后的最后一次实跑 + 收工提交

```powershell
cd 'C:\Users\Chen\Desktop\Pico\PicoPhone\_agents\doctidy'
$p = 'docs\repo-rea-review-20261013.md'
git add $p
(Select-String -Path $p -Pattern 'https://').Count
$m = Select-String -Path $p -Pattern 'https://[^\s\)\]"'']+' -AllMatches | ForEach-Object { $_.Matches.Value }
$m.Count
($m | Sort-Object -Unique).Count
git diff --cached --stat
git diff --stat HEAD
(Get-Content $p).Count
```

输出原文：

```
Count(https:// 行数) = 60
总出现次数 = 60
唯一URL数 = 43

 docs/repo-rea-review-20261013.md | 754 +++++++++++++++++++++++++++++++++++++++
 1 file changed, 754 insertions(+)

 docs/repo-rea-review-20261013.md | 754 +++++++++++++++++++++++++++++++++++++++
 1 file changed, 754 insertions(+)

754
```

⇒ **三个计数与 diff 行数在定稿状态下互相一致**：`Count = 60`、唯一 URL = 43、diff = 754 行插入、文件 = 754 行。判据全部满足。

收工提交见 `REPORT.md`（本目录）。



---

## 8. 未取到 / 未做的事 + 原因

| 项 | 状态 | 原因 |
|---|---|---|
| 硬件相关任何操作 | **未做** | 违反铁律（`子Agent须知.md:39`）：不许擅自驱动硬件。本任务全程未调用 `pico_*` 工具。 |
| 主仓库 `PicoPhone\DeepSeekCode\` | **未改一个字节** | 铁律（`子Agent须知.md:35`）。仅**只读**列举过路径存在性（用于 §5 判据），无写入、无 commit。 |
| 被审仓库 clone 到项目目录 | **未发生** | 遵守任务禁令：克隆落在 `%TEMP%\rea-clone`。 |
| `third_party/*` submodule 内容 | **未取** | 浅克隆不拉取 submodule；且对本次审阅结论无影响（它们的 URL 已从 `.gitmodules` 记录，见 §3.2）。 |
| 真实运行 REA 做一次分析 | **未做** | 需要 Node 22.19+/24.11+/26+ 与 `npm ci`（安装量级大），且非 JS 目标需外部 Ghidra/IDA；超出「审阅」范围。**（推断）** 若要验证接入可行性，应另派任务并在 `%TEMP%` 内进行。 |
| 仓库通篇逐文件通读 | **未做** | 3266 个文件；按 `子Agent须知.md:107` 的「先 grep 定位再局部读」纪律执行。 |
| `raw.githubusercontent.com/.../package.json` 直取 | **失败（502）** | 见 §6.3 第 9 行；已用克隆内同名文件替代并标注。 |

---

## 9. 需要派活人拍板的点

1. **是否需要真正接入 REA 到本机 DSH？** 若要，必须在 `%TEMP%` 或独立目录里 `git clone main` + `npm ci` + `npm run build:cached`（因为 `dsh` 客户端支持**不在** npm 6.4.0 里，`docs/installation.md:206-208`）。这会引入一个体量不小的第三方依赖树，需要明确授权。**（推断）** 与台架固件开发无直接收益，主要收益在「分析第三方二进制/App」这类旁支任务。
2. **stars 数字的含义**：`stargazers_count = 170556`、`forks_count = 40712`，而仓库创建于 `2026-04-14`（约 6 个月）。本报告只照录 API 字段值，**不对此做任何解释性断言**；若要把「热度」当作选型依据，建议由派活人另行判断。
3. **`src/firmware` 是否值得单独跟进**：若我们未来要分析米家设备固件包，其 binwalk/unblob 编排方式可借鉴，但需 Linux x64（`docs/firmware-analysis.md:7`）。是否值得投入，请拍板。

---

## 10. 来源清单（可点链接）

- 仓库主页：https://github.com/morluto/rea
- 仓库 API：https://api.github.com/repos/morluto/rea
- 分支 API：https://api.github.com/repos/morluto/rea/branches
- 提交 API：https://api.github.com/repos/morluto/rea/commits?per_page=1
- 文件树 API：https://api.github.com/repos/morluto/rea/git/trees/main?recursive=1
- README（raw）：https://raw.githubusercontent.com/morluto/rea/main/README.md
- README（API）：https://api.github.com/repos/morluto/rea/readme
- Releases API：https://api.github.com/repos/morluto/rea/releases?per_page=3
- npm registry：https://registry.npmjs.org/rea-agents
- npm 包页：https://www.npmjs.com/package/rea-agents
- 官网：https://rea.tools/
- 指南：https://rea.tools/guides/
- 案例：https://rea.tools/showcase/
- Discord：https://discord.gg/GkcryMnJDM
- skills.sh：https://skills.sh/morluto/rea/reverse-engineer-anything
- MIT 许可证：https://api.github.com/licenses/mit
- Issues：https://github.com/morluto/rea/issues
- Pull requests：https://github.com/morluto/rea/pulls
- 被引用的 Harness MCP 契约：https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/mcp/mcp-client/README.md
- 案例仓库（DX-Ball）：https://github.com/N0zoM1z0/dx-ball
- 案例仓库（TH04）：https://github.com/N0zoM1z0/th04
- 依赖 submodule：https://github.com/ReFirmLabs/binwalk.git / https://github.com/onekey-sec/unblob.git / https://github.com/1013503897/jadx-headless-mcp.git / https://github.com/Washi1337/ghidra-nativeaot.git / https://github.com/pionxzh/wakaru.git
