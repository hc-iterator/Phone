# GitHub 读取通道（`tools/github_read.ps1`）

> 立的日期：**2026-10-13**。适用对象：在本机（Hosts 模式加速器）上干活、需要读 GitHub 的 agent。
> 一句话：**`web_fetch` 读不了 GitHub ✗，但本机 `pwsh` 能 ✓** —— 所以走 `tools/github_read.ps1`：
> 取回 → 落地临时文件 → 再用 `read` / `grep` 读那个文件 ✓。

---

## 1. 现象与实测证据（都是 2026-10-13 在本机复跑出来的原文）

**证据 ①：hosts 把 GitHub 域全部指向 `127.0.0.1`**（`C:\Windows\System32\drivers\etc\hosts`，2026-10-13 实测）

```
127.0.0.1 github.com
127.0.0.1 api.github.com
127.0.0.1 raw.githubusercontent.com
127.0.0.1 githubusercontent.com
```

（同一时刻按域名解析，2026-10-13 实测：`Resolve-DnsName github.com -Type A` ⇒ `github.com -> 127.0.0.1`）
⇒ **不是"网断了"，是域名在本机就解析成回环地址。**

**证据 ②：`443` 与 `80` 由本机的加速器本地反代监听**（2026-10-13 实测，PID 2060）

```
LocalAddress LocalPort OwningProcess
------------ --------- -------------
0.0.0.0             80          2060
0.0.0.0            443          2060
```

⇒ GitHub 域虽然指向 `127.0.0.1`，但本地这两个端口有人接 ⇒ 本机进程照样能真的上 GitHub ✓。

**证据 ③：本机进程（`pwsh`）实测能正常上 GitHub**（2026-10-13 实测）

```powershell
$r = Invoke-WebRequest -Uri 'https://github.com/XiaoMi/ha_xiaomi_home' -UseBasicParsing -UserAgent 'Mozilla/5.0' -TimeoutSec 60
"StatusCode=$($r.StatusCode) RawLength=$($r.RawContentLength) ContentLength=$($r.Content.Length)"
```
```
StatusCode=200 RawLength=401560 ContentLength=401346
```
〔2026-10-13 注：派活人先前记录为「HTTP 200 / 401347 字节」；本次复跑得 `ContentLength=401346`（字符数）、`RawLength=401560`（原始字节），差异来自 UA 与抓取时刻不同，**结论不变** ✓〕

**同一天、同一台机器上，平台的 `web_fetch` 对同一个 URL 的原文回答是：**

```
Error: URL hostname "github.com" resolves to a non-public IP address
```

⇒ 结论：**`web_fetch` 在发请求之前先做"域名必须解析到公网 IP"的护栏校验**，被 hosts 挡在门外 ✗
（它连请求都没发出去 ⇒ 与本机能不能连通 GitHub 无关）。

---

## 2. 为什么四种加速模式都救不了 `web_fetch`

| 加速模式 | 它改什么 | 对 `web_fetch` 的结果 |
|---|---|---|
| `Hosts` | 改 hosts：GitHub 域 → `127.0.0.1` | 域名解析到本地 ⇒ **被护栏拒** ✗ |
| `DNSIntercept` | 拦截 DNS 查询，同样回本地地址 | 同上 ⇒ **被护栏拒** ✗ |
| `PAC` | 不动 hosts，靠代理自动配置脚本 | 域名解析回公网 IP ⇒ **过护栏** ✓，但 `web_fetch` **不读 WinINET 系统代理** ⇒ **照样上不去** ✗ |
| `System` | 不动 hosts，走系统代理 | 同上 ⇒ **照样上不去** ✗ |

〔以上四行结论为 2026-10-13 派活方的实测记录；其中 `Hosts` 一行（证据 ①③）与"`web_fetch` 直拒"的原文已由本文件复现 ✓〕

两条要点：

- 护栏看的是**域名的解析结果**，不是"能不能连得通" ⇒ 只要 hosts / 拦截把 GitHub 指到 `127.0.0.1`，
  `web_fetch` 就连请求都发不出去（`Hosts`、`DNSIntercept` 两种模式）。
- 后两种模式能过护栏，但 `web_fetch` **不走 WinINET 系统代理** ⇒ PAC / System 的代理对它无效 ✗。

⇒ **四种模式没有任何一种能让 `web_fetch` 读到 GitHub** ✓（这不是推测，是实测结论）。
⇒ 所以必须给台架一条**正经的读 GitHub 通道**：本机进程取回 + 落地文件 + agent 用 `read`/`grep` 读 ✓。

---

## 3. 脚本用法

### 3.1 接口

```powershell
pwsh -NoProfile -File tools\github_read.ps1 -Url <URL> [-Out <路径>] [-Lines N] [-Json]
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `-Url` | ✓ | 支持 `github.com` 页面、`raw.githubusercontent.com` 原文件、`api.github.com` 接口 |
| `-Out` | ✗ | 目标文件。默认 `$env:TEMP\github_read_<yyyyMMdd-HHmmss>.<按内容猜的扩展名>`；相对路径按当前目录解析；给目录则自动起默认文件名；路径无扩展名会补上猜到的扩展名 |
| `-Lines` | ✗ | 打印落盘文件的**前 N 行**做预览，默认 `20`；`0` = 不预览。预览每行截到 240 字符（HTML / 压缩 JSON 常常只有一行几十万字符）。`-Json` 模式下不预览原文 |
| `-Json` | ✗ | api 响应用 `ConvertFrom-Json` 解析后，stdout 打**紧凑摘要**（键值 + `JSON_MINI`）而非原文；**文件里仍是原文 JSON**（保持可 grep ✓） |

- **最后一行固定是机器可读结果**：`OUT=<绝对路径> BYTES=<字节数> SHA256_16=<前16位>` ✓
- **失败不静默**：最后一行 `ERR=<原因>` + 非零退出码 ✓
- 落盘：拿得到原始响应字节就**逐字节写**（GitHub 的文本响应本来就是 UTF-8 ✓）；拿不到字节时用 **UTF-8 无 BOM** 写字符串 ✓
- 实现只用 `Invoke-WebRequest`（带 `User-Agent`），**不用 `curl`** ✓

### 3.2 调用方式：**只有沙箱外的 `pwsh -NoProfile -File` 可用** ✓

**① `pico_run` —— 不可用 / 不推荐** ✗（2026-10-13 实测，主仓库已合入本脚本之后）

`pico_run` 确实是"**沙箱内，可以自己写脚本随便跑**"✓，**新建脚本也确实不需要信任门登记** ✓
（信任门只管 §3.3 那 10 个受管脚本，见下）—— 但 **"脚本能在沙箱里跑"与"沙箱里能不能联网/TLS"是两件事** ✗：
脚本跑得起来 ✓，网络出不去 ✗。

〔2026-10-13 注：本节原先写的是"① `pico_run`（沙箱内、**推荐** ✓）……合进主仓库之后 ① 才可用 ✓"，
**该结论已被实测推翻** ✗，按"只划掉加注、不删"的口径保留此注；下面换成实测结论。〕

派活方 2026-10-13 实跑原文（我用同一参数复跑，stdout **逐字一致** ✓）：

```
pico_run(script:"tools/github_read.ps1", args:["-Url","https://api.github.com/repos/morluto/rea","-Json","-Lines","2"])
=> ok=false exitCode=1  sandbox={"mode":"workspace-write","denied":false,"enforcement":"partial"}  2539ms
--- stdout ---
ERR=request failed :: The SSL connection could not be established, see inner exception.
```

2026-10-13 我在同一沙箱里补跑的判据（都用 `pico_run` 跑同一个脚本，参数不同）：

| 沙箱内请求 | 沙箱内结果（原文） |
|---|---|
| `-Url https://api.github.com/repos/morluto/rea -Json` | `ERR=request failed :: The SSL connection could not be established, see inner exception.` |
| `-Url https://example.com`（公网域、不在 hosts 里） | 同上，**同一条 SSL 错** |
| `-Url https://127.0.0.1/` | 同上，**同一条 SSL 错** |
| `-Url http://127.0.0.1/`（明文 HTTP → 加速器 `:80`） | `ERR=HTTP 404 :: Response status code does not indicate success: 404 (Not Found).` |
| `-Url http://127.0.0.1:443/`（**明文** HTTP → 加速器 `:443`） | `ERR=HTTP 404 :: Response status code does not indicate success: 404 (Not Found).` |

**读法（2026-10-13）**：沙箱里 **TCP 与明文 HTTP 是通的** ✓（`127.0.0.1` 的 `80` 与 `443` 都答了 404）；
**挂的是 TLS 那一步** ✗。而且**不是 GitHub 域的问题** ✗ —— 公网的 `example.com` 照样 SSL 失败。

**根因定位到哪一层（2026-10-13）**：

- 同一沙箱模式（`sandbox={"mode":"workspace-write",…}`）下用 `pico_exec` 跑 `python`（自带 CA bundle 的 OpenSSL，不是 .NET）实测：

  ```
  py 3.14.5
  proxies {}
  dns example.com 172.66.147.243
  dns api.github.com 127.0.0.1
  dns raw.githubusercontent.com 127.0.0.1
  OK   https://example.com 200 577
  OK   https://api.github.com/repos/morluto/rea 200 5195
  FAIL http://127.0.0.1:443/ HTTPError HTTP Error 404: Not Found
  ```

  ⇒ **沙箱的网络本身没问题 ✓、加速器那条 loopback 通道也没问题 ✓（api.github.com 在沙箱里也能拿到 200 / 5195 字节）**。
  ⇒ 真正挂掉的是**沙箱里 PowerShell/.NET 的 HTTP(S) 栈** ✗。
- 最内层原因**未定位** ✗：脚本打出来的是 .NET 的**外层**消息（`see inner exception`），内层异常在沙箱里看不到。
  候选（**只是候选，未证实**）：沙箱进程读不到 Windows 证书存储 ⇒ Schannel 链构建失败。
  **本文件只记录到"TLS 层挂、网络层通"这一层判据，不下结论到证书存储。**
- ⚠️ 别为了"在沙箱里也能用"去拿 `python` / `node` 反调 `powershell` 绕开 ✗ —— 那是**绕沙箱**，不是解决办法。

> 附一个仍然成立、但与上面无关的事实：`pico_run` 解析的是**主仓库**的 `tools\`
> （`path.join(cfg.root, 'DeepSeekCode', 'tools', …)`）。2026-10-13 在**子 agent 空间**里调
> `pico_run(script: "tools/github_read.ps1")` 的原文是
> `脚本不存在: C:\Users\Chen\Desktop\Pico\PicoPhone\DeepSeekCode\tools\github_read.ps1` ✗。

**② `pwsh -NoProfile -File`（沙箱外直跑）—— 唯一可用路径** ✓ —— 任何位置都能用：

```powershell
pwsh -NoProfile -File tools\github_read.ps1 -Url https://github.com/XiaoMi/ha_xiaomi_home
# 换目录调用时，脚本路径给绝对路径更稳：
pwsh -NoProfile -File C:\Users\Chen\Desktop\Pico\PicoPhone\_agents\toolchain\tools\github_read.ps1 -Url https://api.github.com/repos/XiaoMi/ha_xiaomi_home -Json
```

### 3.3 红线：这 10 个脚本**一个都不许改** ✗

`C:\Users\Chen\Desktop\Pico\_picophone_trust\trusted-scripts.json` 登记的受管脚本受**哈希信任门**管辖。
`dsh-plugins\dsh-picophone\index.js` 的 `treeIsTrusted()`（**349-351 行**）要求**全部**登记指纹逐一对上：

```js
function treeIsTrusted(cfg) {
  return trustedScripts(cfg).every((rel) => trustVerdict(cfg, path.join(cfg.root, rel)).ok);
}
```

只要**一个**对不上，`ensureRuntimeTree()`（**361-362 行**）就 `return null` ⇒ **fail-closed**，
整个"运行本"刷新失败 ⇒ **连烧写都会挂** ✗：

```js
function ensureRuntimeTree(cfg) {
  if (!treeIsTrusted(cfg)) return null;
```

清单（`index.js:286-302` 的 `TRUSTED_REPO_TOOLS_REL` 9 项 + `TRUSTED_PLUGIN_REL` 1 项 = **10 项**）：

| # | 登记键 | 说明 |
|---|---|---|
| 1 | `DeepSeekCode/tools/build.cmd` | 根工程构建 |
| 2 | `DeepSeekCode/tools/build_sub.ps1` | 子工程构建 |
| 3 | `DeepSeekCode/tools/serial.ps1` | 串口 |
| 4 | `DeepSeekCode/tools/flash_bootsel.ps1` | BOOTSEL 烧写 |
| 5 | `DeepSeekCode/tools/flash_backdoor.ps1` | 后门烧写 |
| 6 | `DeepSeekCode/tools/swd.ps1` | SWD |
| 7 | `DeepSeekCode/tools/proc_guard.ps1` | 进程护栏 |
| 8 | `DeepSeekCode/tools/host_test/run_all.cmd` | 主机自测入口 |
| 9 | `DeepSeekCode/tools/serial_worker.ps1` | 串口子脚本 |
| 10 | `dsh-plugins/dsh-picophone/serial-session.ps1` | 常驻串口会话 worker |

〔2026-10-13 注：派活方口述的清单给了 **9** 项、漏了第 9 项 `tools/serial_worker.ps1`；
本表按 `index.js:286-301` 与 `trusted-scripts.json` 实测核对为 **10** 项 ✓（两边逐项一致）〕

⇒ 想改这些行为，走 `pico_amend` 之类的**正规审批通道** ✗，**别自己绕过** ✗。
⇒ 反过来说：**新建**脚本（比如本文件要的 `tools/github_read.ps1`）**不在**这张表里 ⇒ 不触发信任门 ✓。

### 3.4 示例命令（2026-10-13 三条都真跑过）

```powershell
pwsh -NoProfile -File tools\github_read.ps1 -Url https://github.com/XiaoMi/ha_xiaomi_home
pwsh -NoProfile -File tools\github_read.ps1 -Url https://raw.githubusercontent.com/XiaoMi/ha_xiaomi_home/main/doc/README_zh.md
pwsh -NoProfile -File tools\github_read.ps1 -Url https://api.github.com/repos/XiaoMi/ha_xiaomi_home -Json
```

实测的三行结果（原文）：

```
OUT=C:\Users\Chen\AppData\Local\Temp\github_read_20261013-134743.html BYTES=401561 SHA256_16=930c473e20075560
OUT=C:\Users\Chen\AppData\Local\Temp\github_read_20261013-134745.md BYTES=21255 SHA256_16=acca285eb94eb084
OUT=C:\Users\Chen\AppData\Local\Temp\github_read_20261013-134746.json BYTES=6372 SHA256_16=5b0d7c347af1f664
```

拿到 `OUT=` 之后，用 **`read` / `grep` 读那个文件** ✓（别把大文件整个打到 stdout ✗）。

---

## 4. 什么时候用哪个

| 场景 | 用谁 |
|---|---|
| 公网域名（`docs.python.org`、`example.com` 之类，解析到公网 IP） | **`web_fetch`** ✓ |
| `github.com` / `api.github.com` / `raw.githubusercontent.com` / `*.githubusercontent.com` | **`tools/github_read.ps1`** ✓ |
| 只要仓库目录树或单个文件，且本机 `git` 通 | `git clone --depth 1 --filter=blob:none --no-checkout` 更快 ✓（见 `子Agent须知.md` §三） |
| 私有仓库 / 需要 token / 大文件下载 | 本脚本暂不支持 token ✗（用 `git` 的凭据链，或给人去办） |

**判断口诀：域名解析到 `127.0.0.1` 的 ⇒ 本脚本；解析到公网 IP 的 ⇒ `web_fetch`。** ✓
