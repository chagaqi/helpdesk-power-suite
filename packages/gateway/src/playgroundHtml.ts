/** Self-contained playground page (no external assets; inline script/style gated by a CSP nonce). */
export function playgroundHtml(nonce: string, o: { maxRecords: number; rateLimit: number }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Helpdesk Power Suite Playground</title>
<style nonce="${nonce}">
:root{--bg:#f6f8fa;--card:#fff;--fg:#1d2733;--muted:#5f6b77;--border:#d8dee4;--accent:#1f73b7;--accent-fg:#fff;--ok:#0a7d4f;--warn:#a35b00;--bad:#c6303e;--chip:#eef3f8}
@media (prefers-color-scheme: dark){:root{--bg:#0f141a;--card:#161d25;--fg:#e6edf3;--muted:#98a4b0;--border:#2b3642;--accent:#4c9be8;--accent-fg:#0b1118;--ok:#3fbf86;--warn:#e0a24a;--bad:#ff6b77;--chip:#1e2833}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{padding:28px 16px 8px;max-width:1180px;margin:0 auto}header h1{margin:0;font-size:26px}header p{margin:6px 0 0;color:var(--muted);max-width:760px}
main{max-width:1180px;margin:0 auto;padding:12px 16px 48px;display:grid;grid-template-columns:minmax(0,1fr);gap:20px}
.card{min-width:0}.rule>*{min-width:0}input,select{min-width:0;max-width:100%}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px}
.card h2{margin:0 0 4px;font-size:19px}.card .sub{color:var(--muted);margin:0 0 16px;font-size:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:12px}
label{display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:600;color:var(--muted)}
input,select{font:inherit;color:var(--fg);background:var(--card);border:1px solid var(--border);border-radius:6px;padding:7px 9px}
.check{flex-direction:row;align-items:center;gap:8px;font-weight:500;color:var(--fg);font-size:14px}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
button{font:inherit;border-radius:6px;padding:8px 14px;border:1px solid var(--accent);background:var(--card);color:var(--accent);cursor:pointer}
button.primary{background:var(--accent);color:var(--accent-fg)}button:disabled{opacity:.5;cursor:wait}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:16px 0}
.tile{border:1px solid var(--border);border-radius:8px;padding:10px 12px}.tile b{display:block;font-size:22px;font-variant-numeric:tabular-nums}.tile span{font-size:12px;color:var(--muted)}
.tile.ok b{color:var(--ok)}.tile.warn b{color:var(--warn)}
.msg{padding:10px 12px;border-radius:8px;border:1px solid var(--border);margin-top:12px}.msg.err{border-color:var(--bad);color:var(--bad)}
.table-wrap{overflow:auto;max-height:420px;border:1px solid var(--border);border-radius:8px;margin-top:12px}
table{border-collapse:separate;border-spacing:0;table-layout:fixed;width:max-content;min-width:100%;font-size:13px}
th,td{padding:6px 8px;border-bottom:1px solid var(--border);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left}
th{position:sticky;top:0;background:var(--chip);user-select:none}th .grip{position:absolute;right:0;top:0;bottom:0;width:6px;cursor:col-resize}th .grip:hover{background:var(--accent)}
.rule{display:grid;grid-template-columns:1.4fr 1fr 1fr 1fr 1.3fr auto;gap:8px;align-items:start;padding:10px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px}
@media (max-width:760px){.rule{grid-template-columns:1fr 1fr}}
.effects{list-style:none;padding:0;margin:12px 0 0;display:grid;gap:6px}.effects li{padding:8px 10px;border-radius:6px;background:var(--chip)}
.pill{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;margin-left:6px;border:1px solid var(--border)}
a{color:var(--accent)}footer{color:var(--muted);font-size:13px;text-align:center;padding:0 16px 32px}
</style>
</head>
<body>
<header>
  <h1>Helpdesk Power Suite Playground</h1>
  <p>Try the export engine and the field rule compiler on realistic, generated Zendesk-shaped data. Nothing here touches a real helpdesk. Limit: ${o.rateLimit} runs per hour per IP, up to ${o.maxRecords.toLocaleString('en-US')} records.</p>
</header>
<main>
  <section class="card" aria-labelledby="exp-h">
    <h2 id="exp-h">Cursor export: past the 1,000-row wall, without duplicates</h2>
    <p class="sub">Records are sent in cursor pages. Pages overlap (as shifting offset pagination does), and pages 1–2 are re-sent mid-export (as switching tabs does). The engine dedupes by ID and ignores replayed cursors.</p>
    <div class="grid">
      <label>Records<select id="entity" data-testid="pg-entity"><option value="user">Users</option><option value="ticket">Tickets</option></select></label>
      <label>How many<input id="count" data-testid="pg-count" type="number" min="1" max="${o.maxRecords}" value="1500"></label>
      <label>User state<select id="state" data-testid="pg-state"><option value="all">All users</option><option value="active">Active only</option><option value="suspended">Suspended only</option></select></label>
      <label>Role<select id="role" data-testid="pg-role"><option value="">Any role</option><option value="admin">Admin</option><option value="agent">Agent</option><option value="light_agent">Light agent</option><option value="end_user">End-user</option></select></label>
      <label>Has tag<input id="tagAny" data-testid="pg-tag-any" placeholder="vip"></label>
      <label>Exclude tag<input id="tagNone" data-testid="pg-tag-none" placeholder="churn_risk"></label>
    </div>
    <div class="row">
      <label class="check"><input type="checkbox" id="dups" checked> Overlapping pages</label>
      <label class="check"><input type="checkbox" id="tabs" checked> Tab-switch replay</label>
      <label class="check"><input type="checkbox" id="archived" checked> Include archived tickets</label>
      <span style="flex:1"></span>
      <button class="primary" id="run-csv" data-testid="pg-export-csv">Export CSV</button>
      <button id="run-xlsx" data-testid="pg-export-xlsx">Export Excel (.xlsx)</button>
    </div>
    <div id="exp-out" data-testid="pg-export-out"></div>
  </section>

  <section class="card" aria-labelledby="rules-h">
    <h2 id="rules-h">Field rules by name: per group, role and tag</h2>
    <p class="sub">Pick fields by their names — no numeric IDs. Rules run top to bottom; the first rule that decides a field wins, so put overrides first.</p>
    <div id="rules" data-testid="pg-rules"></div>
    <div class="row"><button id="add-rule" data-testid="pg-add-rule">+ Add rule</button></div>
    <h3 style="font-size:15px;margin:18px 0 8px">Preview as agent</h3>
    <div class="grid">
      <label>Role<select id="ctx-role" data-testid="pg-ctx-role"><option value="agent">Agent</option><option value="admin">Admin</option><option value="light_agent">Light agent</option></select></label>
      <label>Group<select id="ctx-group" data-testid="pg-ctx-group"></select></label>
      <label>Ticket tags<input id="ctx-tags" data-testid="pg-ctx-tags" value="vip"></label>
    </div>
    <button class="primary" id="evaluate" data-testid="pg-evaluate">Evaluate</button>
    <div id="eval-out" data-testid="pg-eval-out"></div>
  </section>
</main>
<footer>Free: 250-row exports &amp; 2 rules. Pro ($19/mo): unlimited. Zendesk · Freshdesk · Freshservice · Gorgias · Intercom.</footer>
<script nonce="${nonce}">
(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v); } for (const k of kids.flat()) if (k != null) e.append(k instanceof Node ? k : String(k)); return e; };
  const fmt = (n) => Number(n).toLocaleString('en-US');
  const csvList = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
  async function post(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || 'Request failed');
    return j;
  }
  function table(cols, rows) {
    const colgroup = el('colgroup', {}, cols.map(() => el('col', { style: 'width:140px' })));
    const head = el('tr', {}, cols.map((c, i) => {
      const grip = el('span', { class: 'grip', 'data-testid': 'pg-grip' });
      grip.addEventListener('pointerdown', (e) => { const col = colgroup.children[i]; const x0 = e.clientX; const w0 = col.getBoundingClientRect().width || 140; grip.setPointerCapture(e.pointerId); const mv = (ev) => (col.style.width = Math.max(50, w0 + ev.clientX - x0) + 'px'); const up = () => { grip.removeEventListener('pointermove', mv); grip.removeEventListener('pointerup', up); }; grip.addEventListener('pointermove', mv); grip.addEventListener('pointerup', up); });
      const th = el('th', { title: c, style: 'position:sticky' }, c, grip); return th; }));
    const body = rows.map((r) => el('tr', {}, r.map((v) => el('td', { title: v == null ? '' : String(v) }, v == null ? '' : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v)))));
    return el('div', { class: 'table-wrap' }, el('table', { 'data-testid': 'pg-preview' }, colgroup, el('thead', {}, head), el('tbody', {}, body)));
  }
  async function runExport(format) {
    const out = $('exp-out');
    const btns = [$('run-csv'), $('run-xlsx')];
    btns.forEach((b) => (b.disabled = true));
    out.replaceChildren(el('p', { class: 'msg' }, 'Streaming cursor pages through the engine…'));
    const filters = { userState: $('state').value };
    if ($('role').value) filters.roles = [$('role').value];
    const any = csvList($('tagAny').value), none = csvList($('tagNone').value);
    if (any.length || none.length) filters.tags = { ...(any.length ? { any } : {}), ...(none.length ? { none } : {}) };
    if ($('entity').value === 'ticket') { delete filters.userState; delete filters.roles; filters.includeArchived = $('archived').checked; }
    try {
      const r = await post('/playground/api/export', { entity: $('entity').value, count: Number($('count').value), simulateDuplicates: $('dups').checked, simulateTabSwitch: $('tabs').checked, format, filters });
      const s = r.stats;
      out.replaceChildren(
        el('div', { class: 'tiles' },
          el('div', { class: 'tile' }, el('b', { 'data-testid': 'pg-pages' }, fmt(r.pagesSent)), el('span', {}, 'cursor pages sent')),
          el('div', { class: 'tile' }, el('b', {}, fmt(s.received)), el('span', {}, 'records received')),
          el('div', { class: 'tile ok' }, el('b', { 'data-testid': 'pg-rows' }, fmt(s.rows)), el('span', {}, 'unique rows exported')),
          el('div', { class: 'tile warn' }, el('b', { 'data-testid': 'pg-dups' }, fmt(s.duplicatesDropped)), el('span', {}, 'duplicates removed')),
          el('div', { class: 'tile' }, el('b', { 'data-testid': 'pg-replayed' }, fmt(s.replayedBatches)), el('span', {}, 'replayed pages ignored')),
          el('div', { class: 'tile' }, el('b', { 'data-testid': 'pg-filtered' }, fmt(s.filteredOut)), el('span', {}, 'filtered out'))),
        el('div', { class: 'row' }, el('a', { href: r.downloadUrl, download: r.filename, 'data-testid': 'pg-download' }, 'Download ' + r.filename + ' (' + fmt(r.bytes) + ' bytes)'), el('span', { class: 'pill' }, 'link expires ' + new Date(r.expiresAt).toLocaleTimeString())),
        table(r.columns, r.preview),
        el('p', { class: 'sub', style: 'margin-top:8px' }, 'Preview of the first 25 rows — drag column edges to resize. Custom fields appear under their titles.'));
    } catch (e) {
      out.replaceChildren(el('p', { class: 'msg err', 'data-testid': 'pg-error' }, e.message));
    } finally { btns.forEach((b) => (b.disabled = false)); }
  }
  $('run-csv').addEventListener('click', () => runExport('csv'));
  $('run-xlsx').addEventListener('click', () => runExport('xlsx'));

  let catalog = { fields: [], groups: [] };
  const ACTIONS = [['hide', 'Hide'], ['show', 'Show (override)'], ['disable', 'Make read-only'], ['enable', 'Make editable (override)'], ['require', 'Require'], ['set_value', 'Set value']];
  function ruleRow(r = {}) {
    const opt = (v, l, sel) => el('option', { value: v, selected: sel || false }, l);
    const name = el('input', { value: r.name || '', placeholder: 'Rule name', 'data-k': 'name' });
    const group = el('select', { 'data-k': 'group' }, opt('', 'Any group'), catalog.groups.map((g) => opt(g.name, g.name, g.name === r.group)));
    const role = el('select', { 'data-k': 'role' }, opt('', 'Any role'), [['agent', 'Agent'], ['light_agent', 'Light agent'], ['admin', 'Admin']].map(([v, l]) => opt(v, l, v === r.role)));
    const action = el('select', { 'data-k': 'action' }, ACTIONS.map(([v, l]) => opt(v, l, v === r.action)));
    const field = el('select', { 'data-k': 'field' }, catalog.fields.map((f) => opt(f.name, f.name, f.name === r.field)));
    const tag = el('input', { value: r.tag || '', placeholder: 'when tagged… (optional)', 'data-k': 'tag' });
    const value = el('input', { value: r.value || '', placeholder: 'value', 'data-k': 'value', style: r.action === 'set_value' ? '' : 'display:none' });
    action.addEventListener('change', () => (value.style.display = action.value === 'set_value' ? '' : 'none'));
    const row = el('div', { class: 'rule', 'data-testid': 'pg-rule' },
      el('label', {}, 'Name', name), el('label', {}, 'Agent group', group), el('label', {}, 'Agent role', role), el('label', {}, 'Then', action), el('label', {}, 'Field (by name)', field, value),
      el('button', { 'aria-label': 'Remove rule', onclick: () => row.remove() }, '×'));
    row.append(el('label', { style: 'grid-column:1/-1' }, 'Ticket tag condition', tag));
    $('rules').append(row);
  }
  function collect() {
    return [...document.querySelectorAll('[data-testid=pg-rule]')].map((row) => {
      const v = (k) => row.querySelector('[data-k=' + k + ']').value.trim();
      const conditions = {};
      if (v('group')) conditions.groups = [v('group')];
      if (v('role')) conditions.roles = [v('role')];
      if (v('tag')) conditions.tags = { any: csvList(v('tag')) };
      const action = { type: v('action'), field: v('field') };
      if (action.type === 'set_value') action.value = v('value');
      return { name: v('name') || 'Untitled rule', conditions, actions: [action] };
    });
  }
  $('add-rule').addEventListener('click', () => ruleRow());
  $('evaluate').addEventListener('click', async () => {
    const out = $('eval-out');
    try {
      const ctx = { user: { role: $('ctx-role').value, groups: $('ctx-group').value ? [$('ctx-group').value] : [] }, ticket: { tags: csvList($('ctx-tags').value) } };
      const r = await post('/playground/api/evaluate', { rules: collect(), context: ctx });
      const items = Object.values(r.evaluation.fields);
      out.replaceChildren(
        ...r.problems.map((p) => el('p', { class: 'msg err' }, 'Rule ' + (p.rule + 1) + ': ' + p.message)),
        el('ul', { class: 'effects' }, items.length ? items.map((f) => el('li', { 'data-field': f.name },
          el('strong', {}, f.name),
          f.hidden ? el('span', { class: 'pill' }, 'hidden') : f.hidden === false ? el('span', { class: 'pill' }, 'shown') : null,
          f.disabled ? el('span', { class: 'pill' }, 'read-only') : null,
          f.required ? el('span', { class: 'pill' }, 'required') : null,
          f.setValue ? el('span', { class: 'pill' }, 'set to ' + JSON.stringify(f.value)) : null,
          el('span', { class: 'pill' }, 'by ' + Object.values(f.decidedBy).map((id) => (r.rules.find((x) => x.id === id) || {}).name).join(', ')))) : el('li', {}, 'No field changes for this agent.')),
        ...r.evaluation.warnings.map((w) => el('p', { class: 'msg' }, w)));
    } catch (e) { out.replaceChildren(el('p', { class: 'msg err' }, e.message)); }
  });
  fetch('/playground/api/catalog').then((r) => r.json()).then((j) => {
    catalog = j.catalog;
    $('ctx-group').replaceChildren(el('option', { value: '' }, 'No group'), ...catalog.groups.map((g) => el('option', { value: g.name, selected: g.name === 'Tier 1 Support' }, g.name)));
    ruleRow({ name: 'Tier 2 sees escalation notes', group: 'Tier 2 Escalations', action: 'show', field: 'Internal Escalation Notes' });
    ruleRow({ name: 'Hide escalation notes', action: 'hide', field: 'Internal Escalation Notes' });
    ruleRow({ name: 'VIP tickets need a tier', action: 'require', field: 'Customer Tier', tag: 'vip' });
  });
})();
</script>
</body>
</html>`;
}
