/**
 * dsh-admin-gate · 客户端半（Web UI）
 * ================================================================
 * 落点：
 *   1. settings.section                        「管理员权限」页（id=admin-gate, order=60）
 *   2. sidebar.workspaces.session.menu.item   会话「…」菜单一项「设置」→ 只给提示
 *   3. 不再自绘浮层（上次的黑框就是自绘、没接主题 token）
 *
 * 所有颜色/边框都取 DSH 主题 token（--dsw-alias-*），亮暗主题都跟随。
 * 数据与动作走 Host 的 /api/admin-gate（文件型插件客户端没有 host.call）。
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-admin-gate',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    // 插件自己的路由前缀（/api 是 DSH 保留的 RPC 前缀，插件路由注册在那儿不会被命中）
    const API = '/.dsh-admin-gate';

    const PERM = [
      ['admin.query', '查询当前管理员（所有 agent）', true],
      ['admin.grant', '任命 / 撤销管理员（用户与管理员）', true],
      ['session.pause', '暂停同工作目录会话（未实现）', false],
      ['session.create', '新建对话（未实现）', false],
      ['model.set', '改思考等级 / 模型（未实现）', false],
      ['dsh.restart', '重启 DSH（未实现，须审批员）', false],
    ];

    /** 读响应：不是 JSON 时不抛异常，返回可读状态（404 之类的纯文本）。 */
    async function readJson(r) {
      const text = await r.text();
      try {
        return JSON.parse(text);
      } catch {
        const notFound = r.status === 404 || /not found/i.test(text || '');
        return {
          ok: false,
          notJson: true,
          status: r.status,
          body: String(text || '').slice(0, 160),
          error: notFound ? '接口 404（插件后端未就绪，需重启加载）' : `后端返回非 JSON（HTTP ${r.status}）`,
        };
      }
    }

    async function getState() {
      try {
        const r = await fetch(`${API}/state`, { headers: { accept: 'application/json' } });
        return await readJson(r);
      } catch (e) {
        return { ok: false, error: `连不上后端：${String(e)}` };
      }
    }

    async function post(payload) {
      try {
        const action = payload && payload.action ? payload.action : 'state';
        const body = { ...payload };
        delete body.action;
        const r = await fetch(`${API}/${action}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        return await readJson(r);
      } catch (e) {
        return { ok: false, error: `连不上后端：${String(e)}` };
      }
    }

    function toast(text) {
      try {
        const el = document.createElement('div');
        el.textContent = text;
        el.style.cssText = [
          'position:fixed', 'left:50%', 'bottom:56px', 'transform:translateX(-50%)',
          'background:var(--dsw-alias-bg-overlay)', 'color:var(--dsw-alias-label-primary)',
          'border:1px solid var(--dsw-alias-border-l2)',
          'padding:8px 14px', 'border-radius:8px', 'font-size:13px', 'z-index:9999',
          'pointer-events:none', 'box-shadow:0 6px 20px rgba(0,0,0,.25)',
        ].join(';');
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 2600);
      } catch { /* 提示失败不影响主流程 */ }
    }

    const S = {
      wrap: { padding: '4px 2px', display: 'flex', flexDirection: 'column', gap: '20px', fontSize: '13px', color: 'var(--dsw-alias-label-primary)' },
      h3: { margin: '0 0 8px', fontSize: '14px', fontWeight: '600', color: 'var(--dsw-alias-label-primary)' },
      row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '8px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)' },
      muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
      code: { fontSize: '12px', color: 'var(--dsw-alias-label-primary)' },
      btn: {
        border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)', borderRadius: '6px', padding: '5px 12px',
        cursor: 'pointer', fontSize: '12px',
      },
      btnPrimary: {
        border: '1px solid var(--dsw-alias-brand-primary)', background: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-bg-base)', borderRadius: '6px', padding: '5px 12px',
        cursor: 'pointer', fontSize: '12px',
      },
      chip: {
        marginLeft: '8px', fontSize: '11px', padding: '1px 6px', borderRadius: '4px',
        border: '1px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-secondary)',
      },
      input: {
        width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)', fontSize: '12px',
      },
    };

    function SettingsSection() {
      const [state, setState] = React.useState(null);
      const [selected, setSelected] = React.useState('');
      const [busy, setBusy] = React.useState(false);

      const refresh = React.useCallback(async () => setState(await getState()), []);

      React.useEffect(() => {
        let alive = true;
        getState().then((s) => { if (alive) setState(s); });
        return () => { alive = false; };
      }, []);

      const act = async (payload, okText) => {
        setBusy(true);
        const r = await post(payload);
        setBusy(false);
        toast(r.ok ? okText : `失败：${r.error || r.text || '未知错误'}`);
        await refresh();
      };

      if (!state) return h('div', { style: { ...S.muted, padding: '8px 2px' } }, '加载中…');
      if (state.ok === false) {
        return h('div', { style: { ...S.muted, padding: '8px 2px', color: 'var(--dsw-alias-state-error-primary)' } }, `读取失败：${state.error || '未知错误'}`);
      }

      const admins = state.admins || [];
      const perms = state.permissions || {};
      const audit = state.audit || [];
      const isSelectedAdmin = !!selected && admins.some((a) => a.sessionId === selected);

      return h('div', { style: S.wrap },
        h('div', null,
          h('div', { style: S.h3 }, '指定会话'),
          h('input', {
            style: S.input,
            value: selected,
            placeholder: '粘贴 session-<uuid>',
            onChange: (e) => setSelected(e.target.value.trim()),
          }),
          h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px', alignItems: 'center' } },
            h('button', {
              style: S.btnPrimary,
              disabled: busy || !selected,
              onClick: () => act({ action: 'grant', sessionId: selected }, '已设为管理员'),
            }, '设为管理员'),
            h('button', {
              style: S.btn,
              disabled: busy || !selected,
              onClick: () => act({ action: 'revoke', sessionId: selected }, '已取消管理员'),
            }, '取消管理员'),
            selected ? h('span', { style: { ...S.chip, marginLeft: 0 } }, isSelectedAdmin ? '当前是管理员' : '当前不是管理员') : null)),

        h('div', null,
          h('div', { style: S.h3 }, '管理员列表'),
          admins.length === 0
            ? h('div', { style: S.muted }, '暂无管理员。')
            : h('div', null, admins.map((a) => h('div', { key: a.sessionId, style: S.row },
              h('div', null,
                h('code', { style: S.code }, a.sessionId),
                a.title ? h('span', { style: { marginLeft: '8px', color: 'var(--dsw-alias-label-secondary)' } }, a.title) : null,
                a.bootstrap ? h('span', { style: S.chip }, 'bootstrap') : null),
              h('span', { style: S.muted }, `${a.basis || '?'} · ${a.grantedAt || ''}`))))),

        h('div', null,
          h('div', { style: S.h3 }, '权限项'),
          PERM.map(([id, label, implemented]) => h('label', { key: id, htmlFor: `pm-perm-${id}`, style: S.row },
            h('span', { style: { opacity: implemented ? 1 : 0.55 } }, label),
            h('input', {
              id: `pm-perm-${id}`, type: 'checkbox', role: 'switch',
              checked: perms[id] === true, disabled: busy,
              onChange: (e) => act({ action: 'permission', id, on: e.target.checked }, `已${e.target.checked ? '开启' : '关闭'} ${id}`),
            })))),

        h('div', null,
          h('div', { style: S.h3 }, '最近 10 条审计'),
          audit.length === 0
            ? h('div', { style: S.muted }, '暂无记录。')
            : h('div', null, audit.map((a, i) => h('div', { key: `${a.seq}-${i}`, style: S.row },
              h('div', null,
                h('code', { style: S.code }, `#${a.seq} ${a.action} · ${a.permission}`),
                h('span', { style: { marginLeft: '8px', color: 'var(--dsw-alias-label-secondary)' } }, a.target || '')),
              h('span', { style: S.muted }, `${a.basis || ''} · ${a.result || ''}`))))),

        h('div', { style: { ...S.muted, fontSize: '11px' } },
          `数据源：%DSH_HOME%\\pm\\state.json · bootstrap ${state.bootstrapUsed ? '已用' : '未用'}`),
      );
    }

    // 菜单项：不自绘面板，只提示去哪配置
    function MenuSettingsItem(props) {
      const pair = typeof props.useMenuOpenState === 'function' ? props.useMenuOpenState() : [null, () => {}];
      const setMenuOpen = pair && pair[1] ? pair[1] : () => {};
      return h('button', {
        role: 'menuitem',
        style: {
          display: 'block', width: '100%', textAlign: 'left', background: 'transparent',
          border: '0', padding: '6px 12px', cursor: 'pointer',
          color: 'var(--dsw-alias-label-primary)', fontSize: '13px',
        },
        onClick: () => {
          setMenuOpen(false);
          toast('管理员权限：请到 设置 → 管理员权限 里配置');
        },
      }, '设置');
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'admin-gate', order: 60, label: '管理员权限' },
          SettingsSection,
        ));
        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register(
          { name: 'sidebar.workspaces.session.menu.item', id: 'pm-settings', order: 610, label: '设置' },
          MenuSettingsItem,
        ));
      },
    };
  },
});
