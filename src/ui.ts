export type NavKey = "dashboard" | "stats" | "tokens" | "models" | "requests" | "switches" | "routes" | "connect" | "settings";

const NAV: Array<{ key: NavKey; href: string; label: string }> = [
  { key: "dashboard", href: "/", label: "仪表盘" },
  { key: "stats", href: "/stats", label: "统计" },
  { key: "tokens", href: "/tokens", label: "Token 统计" },
  { key: "models", href: "/models", label: "模型" },
  { key: "requests", href: "/requests", label: "请求日志" },
  { key: "switches", href: "/switches", label: "切换记录" },
  { key: "routes", href: "/routes", label: "线路" },
  { key: "connect", href: "/connect", label: "接入" },
  { key: "settings", href: "/settings", label: "设置" },
];

export function navHtml(active: NavKey): string {
  const links = NAV.map(
    (n) => `<a href="${n.href}"${n.key === active ? ' class="active"' : ""}>${n.label}</a>`,
  ).join("");
  return `<header class="top">
  <a class="brand" href="/">Open<span>Select</span></a>
  <nav>${links}</nav>
  <button type="button" class="btn language-switch" id="languageSwitch" aria-label="Change language">English</button>
  <div class="right">${active === "dashboard" ? "" : '<a class="btn" href="/">返回控制台</a>'}</div>
</header>
<script>
var osLang = 'zh';
try { if (localStorage.getItem('openselect.language') === 'en') osLang = 'en'; } catch (_) {}
function osT(zh, en) { return osLang === 'en' ? en : zh; }
document.documentElement.lang = osLang === 'en' ? 'en' : 'zh-CN';
var osLanguageButton = document.getElementById('languageSwitch');
osLanguageButton.textContent = osT('English', '中文');
if (osLang === 'en') {
  var osNav = {'/':'Dashboard','/stats':'Statistics','/tokens':'Tokens','/models':'Models','/requests':'Requests','/switches':'Switches','/routes':'Routes','/connect':'Connect','/settings':'Settings'};
  document.querySelectorAll('header.top nav a').forEach(function (a) { a.textContent = osNav[a.getAttribute('href')] || a.textContent; });
  var osBack = document.querySelector('header.top .right a');
  if (osBack) osBack.textContent = 'Back to dashboard';
}
osLanguageButton.addEventListener('click', function () {
  try { localStorage.setItem('openselect.language', osLang === 'en' ? 'zh' : 'en'); } catch (_) { return; }
  location.reload();
});
</script>`;
}

export const UI_CSS = `
  :root { color-scheme: dark; --bg:#0b0f17; --panel:#121924; --panel2:#0f1621; --line:#223047; --line2:#2a3a54; --text:#e6edf3; --muted:#8b98a9; --blue:#4c8dff; --cyan:#36d6c3; --purple:#a879ff; --green:#3fb950; --red:#f85149; --amber:#d29922; }
  * { box-sizing: border-box; }
  html { background: var(--bg); }
  body { margin:0; min-height:100vh; background: radial-gradient(1200px 600px at 10% -10%, #16233b 0%, var(--bg) 45%, #080b11 100%); color:var(--text); font:14px/1.5 -apple-system, "PingFang SC", "Segoe UI", sans-serif; }
  a { color:inherit; text-decoration:none; }
  header.top { position:sticky; top:0; z-index:20; display:flex; align-items:center; gap:18px; padding:14px 26px; background:rgba(11,15,23,.88); backdrop-filter:blur(16px); border-bottom:1px solid rgba(34,48,71,.85); flex-wrap:wrap; }
  .brand { font-weight:800; letter-spacing:.3px; font-size:16px; white-space:nowrap; }
  .brand span { color:var(--blue); }
  nav { display:flex; gap:6px; flex-wrap:wrap; min-width:0; }
  nav a { padding:7px 12px; border-radius:9px; color:var(--muted); font-size:13px; white-space:nowrap; }
  nav a:hover { color:var(--text); background:#182235; }
  nav a.active { color:#fff; background:#1b2a45; box-shadow:inset 0 0 0 1px #2c4b7d; }
  .top .right { margin-left:auto; display:flex; gap:8px; align-items:center; }
  .language-switch { margin-left:auto; flex:0 0 auto; }
  main { max-width:1500px; margin:0 auto; padding:24px 26px 70px; min-width:0; }
  .hero { display:flex; justify-content:space-between; align-items:flex-end; gap:16px; flex-wrap:wrap; margin:6px 0 18px; }
  .hero h1 { margin:0; font-size:26px; letter-spacing:-.4px; }
  .hero p { margin:6px 0 0; color:var(--muted); font-size:12.5px; }
  .hero-actions { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  .statusline { color:var(--muted); font-size:12px; line-height:1.7; overflow-wrap:anywhere; }
  h2 { font-size:14px; color:#c7d3e3; margin:24px 0 10px; font-weight:600; }
  h2 .muted { font-size:11.5px; font-weight:400; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr)); gap:14px; min-width:0; }
  .cards { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:14px; margin:16px 0 20px; }
  .card { position:relative; min-width:0; background:linear-gradient(180deg, rgba(20,29,44,.96), rgba(14,21,32,.96)); border:1px solid var(--line); border-radius:14px; padding:16px; overflow:hidden; }
  .card:before { content:""; position:absolute; inset:0 0 auto 0; height:2px; background:linear-gradient(90deg, var(--blue), transparent); opacity:.8; }
  .card.purple:before { background:linear-gradient(90deg, var(--purple), transparent); }
  .card.cyan:before { background:linear-gradient(90deg, var(--cyan), transparent); }
  .card.green:before { background:linear-gradient(90deg, var(--green), transparent); }
  .card .top { display:flex; justify-content:space-between; align-items:center; gap:8px; }
  .card .name { font-weight:700; font-size:15px; }
  .card .key { color:var(--muted); font-size:12px; font-family:ui-monospace, monospace; }
  .lbl { color:var(--muted); font-size:12px; display:flex; justify-content:space-between; gap:8px; }
  .big { font-size:28px; font-weight:800; letter-spacing:-.7px; margin:5px 0 2px; }
  .sub { color:var(--muted); font-size:11.5px; min-height:18px; }
  .more { margin-top:8px; font-size:12px; color:var(--muted); line-height:1.65; }
  .pill { display:inline-block; font-size:11.5px; padding:2px 9px; border-radius:999px; border:1px solid var(--line2); color:var(--muted); white-space:nowrap; }
  .pill.ok { color:var(--green); border-color:#238636; }
  .pill.warn { color:var(--amber); border-color:#9e6a03; }
  .pill.bad { color:var(--red); border-color:#da3633; }
  .pill.dim { color:var(--muted); }
  .btn { background:#172235; color:var(--text); border:1px solid var(--line2); border-radius:9px; padding:7px 12px; font-size:12.5px; cursor:pointer; text-decoration:none; display:inline-block; white-space:nowrap; }
  .btn:hover { background:#1d2b43; }
  .btn.primary { background:#1e5eff; border-color:#3b7bff; }
  .btn.primary:hover { background:#2f6bff; }
  .btn.danger { color:var(--red); border-color:#7d2a27; }
  .btn:disabled { opacity:.45; cursor:wait; }
  .btn.sm { padding:2px 9px; font-size:11.5px; }
  .input, select { background:#0b111b; color:var(--text); border:1px solid var(--line2); border-radius:8px; padding:6px 9px; font-size:12.5px; }
  .input:focus, select:focus { outline:none; border-color:var(--blue); box-shadow:0 0 0 3px rgba(76,141,255,.14); }
  .fr { display:flex; gap:8px; align-items:center; margin-top:9px; flex-wrap:wrap; }
  .fr label { flex:0 0 76px; font-size:12px; color:var(--muted); }
  .fr > input:not([type=range]), .fr > select { min-width:0; }
  .chk { display:flex; gap:6px; align-items:center; margin-top:10px; font-size:12px; color:var(--muted); }
  .btnrow { display:flex; gap:8px; align-items:center; margin-top:10px; flex-wrap:wrap; }
  .msg { font-size:12px; }
  .msg.ok { color:var(--green); }
  .msg.err { color:var(--red); }
  .msg.warn { color:var(--amber); }
  .muted { color:var(--muted); }
  .ok { color:var(--green); }
  .bad { color:var(--red); }
  .warn { color:var(--amber); }
  .yes { color:var(--green); }
  .no { color:#485f78; }
  .mono { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; }
  .tablewrap { min-width:0; max-width:100%; overflow-x:auto; -webkit-overflow-scrolling:touch; border:1px solid var(--line); border-radius:12px; background:rgba(15,22,33,.72); }
  table { width:100%; border-collapse:collapse; font-size:12.5px; }
  th, td { text-align:left; padding:8px 11px; border-bottom:1px solid rgba(34,48,71,.7); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:360px; }
  th { color:var(--muted); font-weight:500; background:rgba(18,25,36,.7); }
  tbody tr:hover { background:rgba(29,43,67,.35); }
  tbody tr:last-child td { border-bottom:0; }
  .tablewrap::-webkit-scrollbar { height:8px; }
  .tablewrap::-webkit-scrollbar-thumb { background:#30363d; border-radius:4px; }
  details { margin-top:10px; font-size:12px; color:var(--muted); }
  details summary { cursor:pointer; }
  details ol { margin:6px 0 0 18px; padding:0; }
  details li { margin:4px 0; line-height:1.5; }
  code { background:#182235; padding:1px 5px; border-radius:4px; font-size:11.5px; color:#c9d1d9; }
  footer { position:static; color:var(--muted); font-size:11.5px; text-align:center; padding:20px 0 0; }
  body[data-view="settings"] .grid { max-width:900px; }
  .summary { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin:16px 0; }
  .summary .card { padding:12px 14px; }
  .summary .lbl { font-size:12px; color:var(--muted); }
  .summary .big { font-size:24px; font-weight:700; margin-top:4px; }
  @media (max-width: 1200px) { .cards { grid-template-columns:repeat(2,minmax(0,1fr)); } }
  @media (max-width: 620px) {
    main { padding:18px 14px 50px; }
    .cards { grid-template-columns:1fr; }
    .hero h1 { font-size:21px; }
    header.top { padding:12px 14px; }
    .top .right { display:none; }
    nav { order:3; width:100%; flex-wrap:nowrap; overflow-x:auto; scrollbar-width:none; }
    nav::-webkit-scrollbar { display:none; }
    nav a { flex:0 0 auto; }
  }
`;
