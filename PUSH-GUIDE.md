# 仓库推送指南（给 Agent 看）

本机处于 **DSH 沙箱**（Windows 路径 ACL + 受限令牌）⇒ 直接用 `git push` 会失败，原因是
git 的凭据助手要 spawn `sh.exe`/`bash.exe`，而沙箱禁命名管道：

```
sh.exe: *** fatal error - couldn't create signal pipe, Win32 error 5
error: failed to execute prompt script
fatal: could not read Username for 'https://github.com'
```

## 一、推 `dsh-plugins` 分支（推荐：直接 git）

token 在 **`.certs/git-token`**（工作区内、已被 `.gitignore` 忽略），CA 在 `.certs/watt-ca.pem`。

```powershell
$dp='C:\Users\Chen\Desktop\Pico\PicoPhone\dsh-plugins'
$tok=(Get-Content "$dp\.certs\git-token" -Raw).Trim()
git -C $dp -c credential.helper= -c core.askPass= `
  -c http.sslBackend=openssl -c http.sslCAInfo="$dp\.certs\watt-ca.pem" `
  push "https://x-access-token:$tok@github.com/hc-iterator/Phone.git" dsh-plugins:dsh-plugins
```

要点：
- **必须** `credential.helper=` + `core.askPass=`（空值）——否则会去 spawn sh/bash 而失败；
- **必须** `http.sslBackend=openssl` + `http.sslCAInfo=<watt-ca.pem>` —— 本机走 Watt Toolkit 代理，schannel 会因吊销检查失败；
- token 只放在**命令行 URL** 里，**不要**写进 `.git/config`，**不要**打印；
- 先 `git -C $dp add/commit`，再 push；本仓库是**孤儿分支** `dsh-plugins`。

## 二、用台架工具 `pico_git` 推（适合主仓 `cfg.repo`）

`pico_git` 在沙箱内跑，自带鉴权装配：`http.sslCAInfo` 用默认的 `.certs/watt-ca.pem`，
token 读 **`cfg.gitTokenFile`**（可通过预设配置指到 `.certs/git-token`）。

```jsonc
// pico_git 参数
{ "args": ["push", "origin", "dsh-plugins"], "mutate": true }   // 改仓库状态必须 mutate:true
```
- 端口：`push/fetch/pull/ls-remote/clone` 自动走 `header` 鉴权，失败再退 `store`；
- ⚠️ 它**只能操作 `cfg.repo`**（`main` / `DeepSeekCode`）或 `_agents/<空间名>` —— **`dsh-plugins` worktree 不在其中**，请用第一节的直接 git；
- ⚠️ 若 `cfg.gitTokenFile` 指向旧 token，会报 `Invalid username or token`。

## 三、常见失败对照

| 现象 | 原因 | 处理 |
|---|---|---|
| `couldn't create signal pipe` / `failed to execute prompt script` | 凭据助手 spawn sh/bash 被沙箱拦 | 加 `-c credential.helper= -c core.askPass=` |
| `schannel: ... CRYPT_E_NO_REVOCATION_CHECK` / `SEC_E_NO_CREDENTIALS` | schannel 在本机代理下不可用 | 用 `http.sslBackend=openssl` + `http.sslCAInfo=watt-ca.pem` |
| `Invalid username or token` | token 失效/被撤销 | 重新走设备码授权（第四节） |
| `Access is denied` | 写了工作区之外的路径 | 写工作区内（如 `.certs/`）|

## 四、token 失效时：重新授权（GitHub device flow）

1. 申请设备码（Node 需 `NODE_EXTRA_CA_CERTS=<watt-ca.pem>`）：
   `POST https://github.com/login/device/code`，`client_id=178c6fc778ccc68e1d6a`，`scope=repo`，头 `Accept: application/json`；
2. 把返回的 `user_code` 给人，人在 **https://github.com/login/device** 输入并授权；
3. 轮询 `POST https://github.com/login/oauth/access_token`（`grant_type=urn:ietf:params:oauth:grant-type:device_code`）；
4. 拿到 `access_token` ⇒ 写入 `.certs/git-token`（**工作区内**）。

## 五、安全规则

- **绝不打印 token**；只在命令行的 URL 里传，跑完即弃；
- **绝不提交** `.certs/git-token`（`.certs/` 已在 `.gitignore`；不要 `git add -f`）；
- token 为 `repo` 全权；需要撤销：GitHub → Settings → Applications → Authorized OAuth Apps → **Revoke**；
- 工作区外的路径（`$DSH_HOME` 等）**不要**尝试写入——沙箱会拒，且需要人工提权。
