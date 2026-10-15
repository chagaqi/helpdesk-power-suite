/** Garden/Crayons-neutral styling so the kit looks native in both Zendesk and Freshworks. */
export const KIT_CSS = `
:root { --hps-fg:#2f3941; --hps-muted:#68737d; --hps-border:#d8dcde; --hps-bg:#fff; --hps-soft:#f8f9f9; --hps-accent:#1f73b7; --hps-danger:#cc3340; --hps-ok:#038153; }
.hps { font: 14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; color: var(--hps-fg); background: var(--hps-bg); }
.hps * { box-sizing: border-box; }
.hps h2 { font-size: 18px; margin: 0 0 12px; }
.hps h3 { font-size: 15px; margin: 16px 0 8px; }
.hps-tabs { display:flex; gap:4px; border-bottom:1px solid var(--hps-border); margin-bottom:16px; }
.hps-tab { border:0; background:none; padding:10px 14px; cursor:pointer; color:var(--hps-muted); border-bottom:3px solid transparent; font:inherit; }
.hps-tab[aria-selected="true"] { color:var(--hps-fg); border-color:var(--hps-accent); font-weight:600; }
.hps-row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:10px; }
.hps-field { display:flex; flex-direction:column; gap:4px; min-width:160px; }
.hps-field > span { font-size:12px; color:var(--hps-muted); font-weight:600; }
.hps input[type=text], .hps input[type=search], .hps select, .hps textarea { font:inherit; padding:6px 8px; border:1px solid var(--hps-border); border-radius:4px; background:#fff; color:inherit; }
.hps select[multiple] { min-height: 84px; }
.hps-btn { font:inherit; padding:7px 14px; border-radius:4px; border:1px solid var(--hps-accent); background:#fff; color:var(--hps-accent); cursor:pointer; }
.hps-btn.primary { background:var(--hps-accent); color:#fff; }
.hps-btn.danger { border-color:var(--hps-danger); color:var(--hps-danger); }
.hps-btn:disabled { opacity:.5; cursor:not-allowed; }
.hps-btn.small { padding:3px 8px; font-size:12px; }
.hps-badge { display:inline-block; padding:1px 8px; border-radius:10px; font-size:12px; background:var(--hps-soft); border:1px solid var(--hps-border); }
.hps-badge.pro { background:#edf7ff; border-color:var(--hps-accent); color:var(--hps-accent); }
.hps-alert { padding:10px 12px; border-radius:4px; margin:8px 0; background:#fff8ed; border:1px solid #f5b53f; }
.hps-alert.error { background:#fff0f1; border-color:var(--hps-danger); }
.hps-alert.ok { background:#edf8f4; border-color:var(--hps-ok); }
.hps-progress { height:6px; background:var(--hps-soft); border-radius:3px; overflow:hidden; margin:6px 0; }
.hps-progress > div { height:100%; background:var(--hps-accent); transition:width .2s; }
.hps-muted { color:var(--hps-muted); font-size:12px; }
.hps-table-wrap { overflow:auto; max-height:60vh; border:1px solid var(--hps-border); border-radius:4px; }
table.hps-table { border-collapse:separate; border-spacing:0; table-layout:fixed; width:max-content; min-width:100%; }
.hps-table th, .hps-table td { padding:6px 8px; border-bottom:1px solid var(--hps-border); text-align:left; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.hps-table th { position:sticky; top:0; background:var(--hps-soft); font-weight:600; z-index:1; user-select:none; }
.hps-table th .hps-resize { position:absolute; right:0; top:0; bottom:0; width:6px; cursor:col-resize; }
.hps-table th .hps-resize:hover, .hps-table th .hps-resize.active { background:var(--hps-accent); }
.hps-table tr:hover td { background:#fafbfc; }
.hps-chips { display:flex; flex-wrap:wrap; gap:4px; }
.hps-chip { display:inline-flex; gap:4px; align-items:center; padding:2px 8px; border-radius:12px; background:var(--hps-soft); border:1px solid var(--hps-border); font-size:12px; cursor:pointer; }
.hps-chip[aria-pressed="true"] { background:#edf7ff; border-color:var(--hps-accent); }
.hps-rule { border:1px solid var(--hps-border); border-radius:6px; padding:10px 12px; margin-bottom:8px; display:flex; gap:12px; align-items:flex-start; }
.hps-rule.disabled { opacity:.55; }
.hps-rule .hps-rule-main { flex:1; }
.hps-card { border:1px solid var(--hps-border); border-radius:6px; padding:14px; margin-bottom:12px; background:#fff; }
.hps-action-row { display:grid; grid-template-columns: 140px 1fr 1fr 32px; gap:6px; margin-bottom:6px; }
.hps-problem { color:var(--hps-danger); font-size:12px; }
`;
