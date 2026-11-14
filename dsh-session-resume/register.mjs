/**
 * 把 dsh-session-resume 注册到某个 DSH profile（默认 web）。
 *
 * 做两件事（幂等，可重复跑）：
 *   1. 在 <profile>/node_modules/@local/ 下建 junction 指向本插件目录；
 *   2. 把 "@local/dsh-session-resume" 加进 profile package.json 的
 *      dsh.profile.bundles 与 dependencies（link: 形式），改前自动备份。
 *
 * 用法：node register.mjs [profileDir]
 *   profileDir 省略时用 %DSH_HOME%\profiles\web
 *
 * 注意：注册后要重启 DSH 才会加载；本脚本不重启任何东西。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_NAME = '@local/dsh-session-resume';
const LINK_NAME = 'dsh-session-resume';

const dshHome = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');
const profileDir = path.resolve(process.argv[2] || path.join(dshHome, 'profiles', 'web'));
const pkgFile = path.join(profileDir, 'package.json');

function fail(msg) {
  console.error('失败：' + msg);
  process.exit(1);
}

if (!fs.existsSync(pkgFile)) fail(`找不到 profile 的 package.json：${pkgFile}`);

// ── 1. junction ────────────────────────────────────────────────────────
const localDir = path.join(profileDir, 'node_modules', '@local');
fs.mkdirSync(localDir, { recursive: true });
const linkPath = path.join(localDir, LINK_NAME);
let linkState = 'kept';
if (fs.existsSync(linkPath)) {
  let st = null;
  try { st = fs.lstatSync(linkPath); } catch {}
  if (st && st.isSymbolicLink()) {
    const target = fs.readlinkSync(linkPath);
    if (path.resolve(target) !== path.resolve(PLUGIN_DIR)) {
      fail(`已有 junction 指向别处：${target}（期望 ${PLUGIN_DIR}）`);
    }
  } else {
    fail(`已存在同名的真实目录（不是 junction）：${linkPath}`);
  }
} else {
  fs.symlinkSync(PLUGIN_DIR, linkPath, 'junction');
  linkState = 'created';
}

// ── 2. profile package.json ────────────────────────────────────────────
const raw = fs.readFileSync(pkgFile, 'utf8');
const pkg = JSON.parse(raw);
pkg.dsh = pkg.dsh || {};
pkg.dsh.profile = pkg.dsh.profile || {};
const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : (pkg.dsh.profile.bundles = []);
const addedBundle = !bundles.includes(PLUGIN_NAME);
if (addedBundle) bundles.push(PLUGIN_NAME);

pkg.dependencies = pkg.dependencies || {};
const linkSpec = 'link:' + PLUGIN_DIR.replace(/\\/g, '/');
const oldDep = pkg.dependencies[PLUGIN_NAME];
const addedDep = oldDep !== linkSpec;
pkg.dependencies[PLUGIN_NAME] = linkSpec;

if (addedBundle || addedDep) {
  const backup = `${pkgFile}.bak-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
  fs.copyFileSync(pkgFile, backup);
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log(`package.json 已更新（备份：${backup}）`);
} else {
  console.log('package.json 已是目标状态，未改动');
}

console.log(JSON.stringify({
  ok: true,
  profile: profileDir,
  junction: { path: linkPath, target: PLUGIN_DIR, state: linkState },
  bundle: { added: addedBundle, list: bundles },
  dependency: { previous: oldDep ?? null, current: linkSpec },
  note: '需要重启 DSH 才会加载本插件',
}, null, 2));
