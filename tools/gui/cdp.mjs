// CDP 客户端：给 Agent 一个"读结构"的通道（浏览器 / Electron）。
//
// 为什么用 CDP 而不是 UIA：Chromium 只把 `Chrome Legacy Window` 暴露给 UIA，
// 网页内容拿不到（实测）。CDP 能直接拿 DOM：每个可点元素的**精确矩形**、文本、选择器，
// 还能直接 `el.click()` —— 不移动真实鼠标、不抢焦点。
//
// 只用 Node 自带的 WebSocket（node≥22 全局可用），不装任何依赖。
//
// 用法：
//   node cdp.mjs list  --port 9333
//   node cdp.mjs tree  --port 9333 [--target <id>] [--limit 200]
//   node cdp.mjs click --port 9333 --selector "#submit"
//   node cdp.mjs type  --port 9333 --selector "input[name=q]" --text "hello"
//   node cdp.mjs eval  --port 9333 --script "document.title"

const args = process.argv.slice(2);
const cmd = args[0] ?? 'list';
function opt(name, dflt) {
  const i = args.indexOf('--' + name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
}
const port = Number(opt('port', '9333'));
const base = `http://127.0.0.1:${port}`;

async function targets() {
  const res = await fetch(`${base}/json/list`);
  if (!res.ok) throw new Error(`HTTP ${res.status} from /json/list`);
  return await res.json();
}

async function pickTarget() {
  const want = opt('target', null);
  const list = (await targets()).filter((t) => t.type === 'page');
  if (want) {
    const hit = list.find((t) => t.id === want || t.id.startsWith(want));
    if (!hit) throw new Error(`找不到目标 ${want}`);
    return hit;
  }
  if (list.length === 0) throw new Error('没有 page 目标（浏览器没开页面？）');
  return list[0];
}

function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      }
    });
    ws.addEventListener('error', (e) => reject(new Error('WS error: ' + (e.message ?? 'unknown'))));
    ws.addEventListener('open', () => {
      resolve({
        send(method, params = {}) {
          const myId = ++id;
          return new Promise((res, rej) => {
            pending.set(myId, { res, rej });
            ws.send(JSON.stringify({ id: myId, method, params }));
            setTimeout(() => {
              if (pending.has(myId)) { pending.delete(myId); rej(new Error(`超时: ${method}`)); }
            }, 15000);
          });
        },
        close() { try { ws.close(); } catch { } },
      });
    });
  });
}

// 页面里跑的探针：把"可点的东西"整理成扁平列表。
const PROBE = `(() => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < 0.05) return null;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return null;
    return r;
  };
  const sel = (el) => {
    if (el.id) return '#' + CSS.escape(el.id);
    const t = el.tagName.toLowerCase();
    if (el.name) return t + '[name="' + el.name + '"]';
    if (el.getAttribute && el.getAttribute('aria-label')) return t + '[aria-label="' + el.getAttribute('aria-label') + '"]';
    let path = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && path.length < 5) {
      let part = cur.tagName.toLowerCase();
      const p = cur.parentElement;
      if (p) {
        const idx = Array.from(p.children).indexOf(cur);
        part += ':nth-child(' + (idx + 1) + ')';
      }
      path.unshift(part);
      const q = path.join(' > ');
      try { if (document.querySelectorAll(q).length === 1) return q; } catch {}
      cur = cur.parentElement;
    }
    return path.join(' > ');
  };
  const out = [];
  const all = document.querySelectorAll('a,button,input,select,textarea,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[onclick],[tabindex]:not([tabindex="-1"])');
  for (const el of all) {
    const r = vis(el);
    if (!r) continue;
    out.push({
      tag: el.tagName.toLowerCase(),
      type: el.type ?? '',
      text: (el.innerText ?? el.value ?? el.placeholder ?? '').trim().slice(0, 60),
      rect: { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) },
      selector: sel(el),
      disabled: !!el.disabled,
    });
    if (out.length >= 400) break;
  }
  return out;
})()`;

const target = await pickTarget();
const conn = await cdpConnect(target.webSocketDebuggerUrl);
try {
  if (cmd === 'list') {
    const list = await targets();
    console.log(`目标 ${list.length} 个（port=${port}）`);
    for (const t of list) console.log(`  ${t.type.padEnd(8)} ${t.id.slice(0, 12)}  ${t.title.slice(0, 50)}  ${t.url.slice(0, 70)}`);
  } else if (cmd === 'tree') {
    const r = await conn.send('Runtime.evaluate', { expression: PROBE, returnByValue: true, awaitPromise: false });
    const items = r.result?.value ?? [];
    const limit = Number(opt('limit', '200'));
    console.log(`可点元素 ${items.length} 个（target=${target.id.slice(0, 12)}）`);
    for (const it of items.slice(0, limit)) {
      console.log(`  ${it.selector}  | ${it.tag}${it.type ? '/' + it.type : ''} | ${it.text} | ${it.rect.x},${it.rect.y} ${it.rect.w}x${it.rect.h}${it.disabled ? ' | disabled' : ''}`);
    }
    console.log(JSON.stringify(items));
  } else if (cmd === 'click') {
    const selector = opt('selector', null);
    if (!selector) throw new Error('缺 --selector');
    const expr = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'not-found'; el.focus && el.focus(); el.click(); return 'clicked'; })()`;
    const r = await conn.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    console.log(`click ${selector} -> ${r.result?.value}`);
  } else if (cmd === 'type') {
    const selector = opt('selector', null);
    const text = opt('text', '');
    if (!selector) throw new Error('缺 --selector');
    const expr = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'not-found'; el.focus(); el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); return 'typed'; })()`;
    const r = await conn.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    console.log(`type ${selector} -> ${r.result?.value}`);
  } else if (cmd === 'eval') {
    const script = opt('script', 'document.title');
    const r = await conn.send('Runtime.evaluate', { expression: script, returnByValue: true, awaitPromise: true });
    console.log(JSON.stringify(r.result?.value ?? r.result));
  } else {
    console.error(`未知命令 ${cmd}`);
    process.exit(2);
  }
} finally {
  conn.close();
}
