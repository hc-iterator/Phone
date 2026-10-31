#!/usr/bin/env bash
# ClawsGO 免费云主机 · 自检 + GitHub 通路 + DSH 启动准备
# 用法：把本文件放到云主机上执行  bash host-bootstrap.sh
# 只做只读检查 + 少量可逆改动；不会删除任何东西。
set -u

say() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

say "1. 机器规格"
echo "CPU   : $(nproc) 核"
echo "内存  : $(free -h | awk '/Mem:/{print $2" 总 / "$7" 可用"}')"
echo "磁盘  : $(df -h / | awk 'NR==2{print $2" 总 / "$4" 可用 ("$5" 已用)"}')"
echo "内核  : $(uname -sr)"

say "2. 已装工具"
for t in git node npm dsh pnpm rg jq curl ssh; do
  if command -v "$t" >/dev/null 2>&1; then printf '  %-6s %s\n' "$t" "$(command -v $t)"; else printf '  %-6s (缺)\n' "$t"; fi
done
[ -x "$(command -v node)" ] && echo "  node 版本 $(node -v)"
[ -x "$(command -v git)" ] && echo "  git  版本 $(git --version | awk '{print $3}')"

say "3. 内存余量（4G 机器的关键）"
free -m | awk '/Mem:/{printf "  可用 %s MB / 共 %s MB\n", $7, $2}'
if ! swapon --show | grep -q .; then
  echo "  没有 swap。4G 机器建议开 2G（需要 sudo）："
  echo "    sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile"
else
  echo "  已有 swap：$(swapon --show=SIZE --noheadings | tr -d '\n')"
fi

say "4. 磁盘预算（10G 盘，别在机器上编译大工程）"
df -h / | awk 'NR==2{print "  剩余 "$4"，已用 "$5}'
echo "  经验：node_modules + 编辑缓存 2-3G，Pico SDK 编译链 ~5G ⇒ 编译放本地，云端只跑轻任务"

say "5. GitHub 三条通路"
printf '  A 直连 https://github.com : '
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 https://github.com 2>/dev/null || echo 000)
echo "${code:-000} $([ "${code:-0}" = "200" ] && echo '✓ 可用' || echo '✗ 超时/被墙')"
printf '  B SSH over 443 (ssh.github.com) : '
if timeout 8 bash -c '</dev/tcp/ssh.github.com/443' 2>/dev/null; then echo '✓ 端口通'; else echo '✗ 不通'; fi
printf '  C ghproxy 镜像 : '
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 'https://ghproxy.net/https://raw.githubusercontent.com/git/git/master/README.md' 2>/dev/null || echo 000)
echo "${code:-000} $([ "${code:-0}" = "200" ] && echo '✓ 可用' || echo '✗ 不可用')"

say "6. git 身份与凭据"
echo "  当前 user.name  : $(git config --global user.name || echo '(未设)')"
echo "  当前 user.email : $(git config --global user.email || echo '(未设)')"
cat <<'TIP'
  设置（把名字/邮箱/PAT 换成你自己的）：
    git config --global user.name  "你的名字"
    git config --global user.email "you@example.com"
    git config --global credential.helper store
    # 首次 push 时输入用户名 + PAT（不要用密码）；之后会存到 ~/.git-credentials
  若直连不通，改用 SSH over 443：
    cat >> ~/.ssh/config <<'EOF'
    Host github.com
      HostName ssh.github.com
      Port 443
      User git
    EOF
    ssh -T git@github.com
TIP

say "7. DSH 自检"
if command -v dsh >/dev/null 2>&1; then
  echo "  dsh 路径: $(command -v dsh)"
  echo "  版本: $(dsh --version 2>/dev/null || echo '(无 --version)')"
else
  echo "  未找到 dsh；若装在 npm 全局：npm ls -g --depth=0 | grep -i dsh"
fi
echo "  端口占用检查（3080 默认 Web UI）:"
ss -lntp 2>/dev/null | grep -E ':3080\b' || echo "    3080 空闲"

say "8. 建议的下一步"
cat <<'NEXT'
  1) 先推一个空仓库验证 GitHub 凭据：
       cd /tmp && git init t && cd t && echo hi > a.txt
       git add . && git commit -m init
       git remote add origin <你的仓库>
       git push -u origin main
  2) DSH 只在轻任务下跑（4G 内存）：
       NODE_OPTIONS=--max-old-space-size=1024 dsh web --no-open
  3) 编译/重型构建放本机，云主机只做"改代码 + 跑测试 + 推 GitHub"
NEXT
