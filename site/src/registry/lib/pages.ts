import type { PackageRecord, VersionRecord } from "./db";

/**
 * Renderers for known.life. Every gene surface is content-negotiated:
 * agents (curl / Accept: application/json|text/markdown) get the dense decision
 * surface; humans get the light pastel "miami-at-noon" HTML — the same palette
 * as the landing page so the genepool and the marketing site feel like one
 * place. Layout is npm-shaped: hero + tabs (readme / code / versions /
 * dependents) in the main column, a sticky metadata sidebar on the right.
 */

// --- design tokens — mirrored from src/pages/index.astro (.life-home) so the
//     genepool and the landing page read as one site. ---
const CSS = `
:root{
  --bg:#ffffff; --panel:#fcfbf9; --panel-2:#f6f4ef;
  --ink:#22201f; --ink-soft:#6c6760; --ink-faint:#a7a097;
  --line:#e7e3db;
  --teal:#3f9488; --teal-pale:#bfe0da;
  --coral:#e07a64; --pink:#d172a0; --peach:#ef9f6a;
  --cyan:#74b6cc; --magenta:#bd5f93; --sun:#f2a25f;
  --radius:14px;
  --mono:"Spline Sans Mono","Space Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --display:"Unbounded","Hanken Grotesk",system-ui,sans-serif;
  --body:"Hanken Grotesk",system-ui,sans-serif;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--ink);font-family:var(--body);line-height:1.6;min-height:100vh;position:relative;overflow-x:hidden}
body::before{
  content:"";position:fixed;inset:0;z-index:2;pointer-events:none;opacity:.025;mix-blend-mode:multiply;
  background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='160' height='160' filter='url(%23n)'/></svg>");
}
a{color:var(--teal);text-decoration:none}
a:hover{color:var(--coral)}
code,pre,.mono{font-family:var(--mono)}

.wrap{position:relative;z-index:3;max-width:1180px;margin:0 auto;padding:0 28px}

/* --- top nav, matching the landing page brand --- */
.nav{display:flex;align-items:center;justify-content:space-between;padding:26px 0 10px}
.nav .brand{font-family:var(--display);font-weight:800;font-size:20px;letter-spacing:-.01em;display:flex;align-items:center;gap:9px;color:var(--ink)}
.nav .brand .glint{width:11px;height:11px;border-radius:50%;
  background:conic-gradient(from 220deg,var(--cyan),var(--pink),var(--peach),var(--cyan));
  box-shadow:0 0 0 2px #fff,0 0 12px rgba(189,95,147,.5)}
.nav .links{display:flex;gap:22px;font-size:14.5px;color:var(--ink-soft);font-weight:500;align-items:center}
.nav .links a{color:inherit}
.nav .links a:hover{color:var(--ink)}
.nav .search{display:flex;align-items:center;gap:8px;background:var(--panel);border:1.4px solid var(--line);
  border-radius:999px;padding:6px 12px;width:280px;max-width:42vw}
.nav .search:focus-within{border-color:var(--teal)}
.nav .search input{flex:1;border:0;outline:0;background:transparent;color:var(--ink);font-family:var(--mono);font-size:13px}
.nav .search input::placeholder{color:var(--ink-faint)}
.nav .search svg{flex:none;color:var(--ink-faint)}

/* --- gene hero --- */
.hero{padding:28px 0 18px;border-bottom:1.4px solid var(--line)}
.hero .row{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;flex-wrap:wrap}
.hero h1{font-family:var(--display);font-weight:800;font-size:clamp(32px,4.5vw,52px);line-height:1;letter-spacing:-.02em;margin:0;
  background:linear-gradient(100deg,var(--magenta),var(--coral) 45%,var(--peach) 78%,var(--sun));
  -webkit-background-clip:text;background-clip:text;color:transparent}
.hero .crumbs{font-family:var(--mono);font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--teal);margin-bottom:10px}
.hero .crumbs a{color:inherit;border-bottom:1px dashed var(--teal-pale)}
.hero .sum{font-size:17.5px;color:var(--ink-soft);margin:10px 0 0;max-width:62ch}
.hero .pills{display:flex;flex-wrap:wrap;gap:7px;margin-top:14px}
.pill{font-family:var(--mono);font-size:11px;letter-spacing:.06em;padding:3px 10px;border-radius:999px;
  border:1.2px solid var(--line);color:var(--ink-soft);background:var(--panel)}
.pill.kw{color:var(--ink-soft)}
/* tiny status icon next to a gene name. tooltip carries the label. */
.b{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;
  font-size:10px;line-height:1;font-weight:700;margin-left:8px;vertical-align:middle;color:#fff;
  font-family:var(--body)}
.b.blessed{background:var(--sun)}
.b.verified{background:var(--teal)}
.superseded-by{display:inline-block;margin-left:8px;padding:1px 7px;border-radius:10px;border:1px solid var(--line);
  font-family:var(--mono);font-size:11px;color:var(--coral);text-decoration:none;vertical-align:middle;white-space:nowrap}
.superseded-by:hover{border-color:var(--coral)}
tr.superseded{opacity:.55}
tr.superseded:hover{opacity:1}
.superseded-banner{margin:8px 0 0;padding:6px 12px;border-left:3px solid var(--coral);background:var(--panel);
  font-size:13px;color:var(--ink)}
.superseded-banner a{color:var(--coral);font-family:var(--mono);font-weight:600}
/* hero variant: slightly larger so it reads next to a 40px+ headline */
.hero .b{width:22px;height:22px;font-size:13px;margin-left:14px;vertical-align:0.18em}

/* --- two-column layout --- */
.cols{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:36px;padding:28px 0 60px;align-items:start}
.main{min-width:0}
.side{position:sticky;top:18px;display:flex;flex-direction:column;gap:18px}

/* --- tabs --- */
.tabs{display:flex;gap:4px;border-bottom:1.4px solid var(--line);margin-bottom:22px;overflow-x:auto}
.tab{appearance:none;background:none;border:0;cursor:pointer;
  font-family:var(--mono);font-size:12.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-faint);
  padding:11px 16px;border-bottom:2px solid transparent;white-space:nowrap}
.tab:hover{color:var(--ink-soft)}
.tab.active{color:var(--ink);border-bottom-color:var(--coral)}
.tab .ct{color:var(--ink-faint);font-size:11px;margin-left:6px}
.tab.active .ct{color:var(--coral)}
.pane{display:none}
.pane.active{display:block}

/* --- readme / prose --- */
.prose{font-size:15.5px;color:var(--ink);max-width:72ch}
.prose h1,.prose h2,.prose h3{font-family:var(--display);font-weight:700;color:var(--ink);letter-spacing:-.01em;margin:1.6em 0 .5em;line-height:1.2}
.prose h1{font-size:28px}
.prose h2{font-size:22px}
.prose h3{font-size:18px}
.prose p{margin:.8em 0;color:var(--ink-soft)}
.prose code{font-family:var(--mono);font-size:13px;background:var(--panel-2);padding:1px 6px;border-radius:5px;color:var(--ink)}
.prose pre{background:var(--panel);border:1.4px solid var(--line);border-radius:10px;padding:14px 16px;overflow:auto;font-size:13px;line-height:1.55;color:var(--ink)}
.prose pre code{background:none;padding:0;font-size:13px}
.prose ul,.prose ol{padding-left:1.4em;color:var(--ink-soft)}
.prose li{margin:.3em 0}
.prose a{color:var(--teal);border-bottom:1px dashed var(--teal-pale)}
.prose blockquote{border-left:3px solid var(--peach);margin:.8em 0;padding:.2em 0 .2em 14px;color:var(--ink-soft)}
.prose hr{border:0;border-top:1.4px dashed var(--line);margin:1.6em 0}
.empty{color:var(--ink-faint);font-style:italic;padding:30px 0}

/* --- versions table --- */
.hist{width:100%;border-collapse:collapse;font-size:14px}
.hist th{text-align:left;font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-faint);font-weight:500;padding:9px 12px;border-bottom:1.4px solid var(--line)}
.hist td{padding:11px 12px;color:var(--ink-soft);border-bottom:1px solid var(--line)}
.hist td:first-child{font-family:var(--mono);color:var(--ink);font-weight:600}
.hist td.num{font-family:var(--mono);color:var(--ink-soft);text-align:right}
.hist tr:hover td{background:var(--panel)}
.hist .dep{display:inline-block;font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;
  color:var(--coral);border:1.2px solid var(--coral);border-radius:999px;padding:1px 8px;background:rgba(224,122,100,.08)}

/* --- dependents list --- */
.deps{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}
.deps a{display:block;padding:12px 14px;border:1.4px solid var(--line);border-radius:10px;background:var(--panel);
  font-family:var(--mono);font-size:13.5px;color:var(--ink)}
.deps a:hover{border-color:var(--coral);color:var(--coral)}

/* --- sidebar cards --- */
.scard{background:var(--panel);border:1.4px solid var(--line);border-radius:var(--radius);padding:16px 18px}
.scard.install{background:linear-gradient(180deg,#fff,#fbf5ee);border-color:var(--ink);box-shadow:5px 6px 0 rgba(34,32,31,.08)}
.scard h4{margin:0 0 10px;font-family:var(--mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--ink-faint);font-weight:500}
.scard .install-say{margin:0;font-size:15px;color:var(--ink);line-height:1.5}
.scard .install-say b{font-family:var(--mono);font-weight:600;color:var(--ink);word-break:break-all}
.copy{margin-top:10px;display:inline-flex;align-items:center;gap:7px;cursor:pointer;
  font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink);
  background:var(--panel-2);border:1.4px solid var(--ink);border-radius:999px;padding:6px 12px;
  box-shadow:3px 3px 0 rgba(34,32,31,.08);transition:transform .12s ease,box-shadow .12s ease,background .12s ease}
.copy:hover{background:#fff;transform:translateY(-1px);box-shadow:4px 4px 0 rgba(34,32,31,.12)}
.copy:active{transform:translateY(0);box-shadow:2px 2px 0 rgba(34,32,31,.08)}
.copy.copied{background:var(--teal);color:#fff;border-color:var(--teal)}

.kv{display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-bottom:1px dashed var(--line);font-size:13.5px}
.kv:last-child{border-bottom:0}
.kv .k{font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-faint);flex:none}
.kv .v{color:var(--ink);text-align:right;word-break:break-all}
.kv .v a{color:var(--teal);border-bottom:1px dashed var(--teal-pale)}

.odo{display:flex;align-items:baseline;gap:8px;font-family:var(--display);font-weight:800;font-size:32px;color:var(--ink);letter-spacing:-.01em;
  background:linear-gradient(100deg,var(--magenta),var(--coral) 60%,var(--peach));-webkit-background-clip:text;background-clip:text;color:transparent}
.odo small{font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-faint);font-weight:500;-webkit-text-fill-color:var(--ink-faint)}

.caplist{display:flex;flex-direction:column;gap:6px}
.caplist code{font-family:var(--mono);font-size:12.5px;background:var(--panel-2);border:1.2px solid var(--line);padding:3px 9px;border-radius:6px;color:var(--ink);align-self:flex-start;max-width:100%;overflow-wrap:anywhere}
.caplist .none{color:var(--ink-faint);font-size:13px;font-style:italic}

/* --- version history (de-emphasised: a collapsed disclosure, not a tab) --- */
.ver-history{padding:0;overflow:hidden}
.ver-history>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:8px;
  padding:15px 18px;font-family:var(--mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--ink-faint)}
.ver-history>summary::-webkit-details-marker{display:none}
.ver-history>summary .vh-n{margin-left:auto;color:var(--ink-faint)}
.ver-history>summary::after{content:"▸";color:var(--ink-faint);transition:transform .15s ease;font-size:13px}
.ver-history[open]>summary::after{transform:rotate(90deg)}
.ver-history .vh-list{padding:0 18px 14px}
.ver-history .vh-row{display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:baseline;
  padding:8px 0;border-top:1px dashed var(--line)}
.ver-history .vh-row a{font-family:var(--mono);font-weight:600;font-size:13px;color:var(--ink)}
.ver-history .vh-row a:hover{color:var(--coral)}
.ver-history .vh-row .d{font-family:var(--mono);font-size:11.5px;color:var(--ink-faint)}
.ver-history .vh-row .n{font-family:var(--mono);font-size:12px;color:var(--ink-soft);text-align:right;white-space:nowrap}
.ver-history .vh-row .dep{color:var(--coral);font-size:10px;text-transform:uppercase;letter-spacing:.06em}

/* --- file viewer (code tab) --- */
.files .fwrap{display:grid;grid-template-columns:240px 1fr;gap:16px}
.ftree{display:flex;flex-direction:column;gap:2px;
  border-right:1px solid var(--line);padding-right:8px}
.fitem{text-align:left;font-family:var(--mono);font-size:12.5px;color:var(--ink-soft);background:none;
  border:0;border-radius:6px;padding:6px 9px;cursor:pointer;white-space:nowrap;width:100%}
.fitem:hover{color:var(--ink);background:var(--panel-2)}
.fitem.active{color:var(--ink);background:var(--panel-2);font-weight:600;border-left:2px solid var(--coral);border-radius:0 6px 6px 0}
.fpanes{min-width:0}
.fpane{display:none}
.fpane.active{display:block}
.fhead{font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-faint);margin-bottom:8px;word-break:break-all}
/* code flows on the page — word-wrapped, no scroll-inside-a-scroll */
.fpane pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;color:var(--ink);font-size:12.5px;
  background:var(--panel);border:1.4px solid var(--line);border-radius:10px;padding:14px 16px;line-height:1.6}
.files .miss{color:var(--coral);font-size:12px;margin-top:10px}
.vselect{margin-bottom:14px;display:inline-flex;align-items:center;gap:8px;font-family:var(--mono);
  font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-faint)}
.vselect select{font-family:var(--mono);font-size:12.5px;color:var(--ink);background:var(--panel);
  border:1.2px solid var(--line);border-radius:8px;padding:6px 10px;cursor:pointer}
.vselect select:hover{border-color:var(--ink-soft)}
/* syntax tokens — muted on cream */
.hl .hc{color:#a39575;font-style:italic}
.hl .hs{color:#b9695a}
.hl .hn{color:#3f9488}
.hl .hkw{color:#bd5f93;font-weight:600}
.hl .hk{color:#3f9488}

/* --- explore / search listings --- */
.list-head{padding:28px 0 8px}
.list-head h1{font-family:var(--display);font-weight:800;font-size:clamp(28px,4vw,40px);letter-spacing:-.02em;margin:0;color:var(--ink)}
.list-head h1 .em{background:linear-gradient(100deg,var(--magenta),var(--coral) 50%,var(--peach));
  -webkit-background-clip:text;background-clip:text;color:transparent;font-style:italic}
.list-head .lead{font-size:16px;color:var(--ink-soft);margin-top:10px;max-width:60ch}
.search-big{display:flex;align-items:center;gap:10px;background:var(--panel);border:1.6px solid var(--ink);border-radius:14px;
  padding:12px 16px;margin:22px 0 8px;box-shadow:5px 6px 0 rgba(34,32,31,.08);max-width:560px}
.search-big input{flex:1;border:0;outline:0;background:transparent;color:var(--ink);font-family:var(--mono);font-size:14.5px}
.search-big input::placeholder{color:var(--ink-faint)}
.search-big svg{flex:none;color:var(--ink-soft)}
.pkg-table{width:100%;border-collapse:collapse;margin:18px 0 60px;font-size:14px}
.pkg-table thead th{text-align:left;font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;
  color:var(--ink-faint);font-weight:500;padding:10px 14px;border-bottom:1.4px solid var(--line);background:transparent}
.pkg-table th.num,.pkg-table td.num{text-align:right;white-space:nowrap}
.pkg-table tbody td{padding:14px;border-bottom:1px solid var(--line);vertical-align:top}
.pkg-table tbody tr:hover td{background:var(--panel)}
.pkg-table tbody tr:last-child td{border-bottom:0}
.pkg-table .nm{font-family:var(--mono);font-weight:600;color:var(--ink);text-decoration:none;font-size:14.5px}
.pkg-table .nm:hover{color:var(--coral)}
.pkg-table .ver{font-family:var(--mono);font-size:12px;color:var(--ink-soft)}
.pkg-table .sum{color:var(--ink-soft);max-width:64ch;line-height:1.5}
.pkg-table .ct{font-family:var(--mono);font-size:13px;color:var(--ink)}
.pkg-table .empty-row td{padding:30px 14px;color:var(--ink-faint);font-style:italic;text-align:center}

/* --- footer --- */
.footer{border-top:1.4px solid var(--line);padding:24px 0 50px;margin-top:30px}
.footer .row{display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px;align-items:center}
.footer .mk{font-family:var(--display);font-weight:800;font-size:15px;color:var(--ink)}
.footer .mono{font-family:var(--mono);font-size:12px;color:var(--ink-faint)}

@media(max-width:980px){
  /* Single column. Flatten the sidebar (display:contents) so its cards become
     flex items of .cols and we can order them around the main content: install
     card on top, everything else (stats / links / provides / requires / history)
     below the readme — instead of burying the readme under every metadata card. */
  .cols{display:grid;grid-template-columns:minmax(0,1fr);gap:18px}
  .side{display:contents}
  .side .scard.install{order:-1}
  .main{order:0;min-width:0}
  .side .scard:not(.install){order:1;min-width:0}
}
@media(max-width:640px){
  .nav .links a:not(.gh):not(.search-trigger){display:none}
  .nav .search{display:none}
  .files .fwrap{grid-template-columns:1fr}
  /* A real, scannable file list — vertical, comfortable tap targets — instead
     of a cramped horizontal wrap. */
  .ftree{flex-direction:column;border-right:0;border-bottom:1.4px solid var(--line);
    max-height:260px;padding:0 0 10px;margin-bottom:14px}
  .fitem{font-size:13.5px;padding:10px 11px;white-space:normal;word-break:break-all}
  .pkg-grid{grid-template-columns:1fr}
  /* Stacked cards instead of a 4-col table that forces sideways scroll. Each
     row becomes a tappable card: name + installs on top, version under it,
     short summary full width below. */
  .pkg-table{display:block;font-size:14px;margin:14px 0 50px}
  .pkg-table thead{display:none}
  .pkg-table tbody{display:block}
  .pkg-table tbody tr{position:relative;display:grid;grid-template-columns:1fr auto;gap:2px 12px;
    padding:14px;border:1.4px solid var(--line);border-radius:12px;margin-bottom:12px;background:var(--panel)}
  .pkg-table tbody tr:hover td{background:transparent}
  .pkg-table tbody tr:active{background:var(--panel-2)}
  .pkg-table tbody tr:last-child td{border-bottom:0}
  .pkg-table tbody td{display:block;padding:0;border:0}
  /* Whole card is the tap target: stretch the gene link to cover the card,
     so a tap anywhere on the card opens the gene — not just the title. */
  .pkg-table td[data-label="gene"] .nm::after{content:"";position:absolute;inset:0;z-index:1}
  .pkg-table td[data-label="gene"]{grid-column:1;grid-row:1;min-width:0;overflow-wrap:anywhere}
  .pkg-table td[data-label="installs"]{grid-column:2;grid-row:1;text-align:right;white-space:nowrap}
  .pkg-table td[data-label="installs"]::after{content:" installs";color:var(--ink-faint);font-size:11px;font-family:var(--mono)}
  .pkg-table td[data-label="version"]{grid-column:1;grid-row:2}
  .pkg-table td[data-label="summary"]{grid-column:1 / -1;grid-row:3;margin-top:4px}
  .pkg-table .nm{font-size:15.5px}
  .pkg-table .sum{max-width:none}
}
`;

const FONT = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Unbounded:wght@600;700;800&family=Hanken+Grotesk:wght@400;500;600;700&family=Spline+Sans+Mono:wght@400;500;600&display=swap" rel="stylesheet">`;

const SEARCH_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`;
const COPY_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;

function nav(): string {
  return `<nav class="nav">
  <a class="brand" href="/"><span class="glint"></span> Life</a>
  <div class="links">
    <form class="search" action="/search" method="get" role="search">
      ${SEARCH_ICON}
      <input type="search" name="q" placeholder="search packages…" aria-label="Search packages">
    </form>
    <a href="/explore">Explore</a>
    <a href="/docs">Docs</a>
    <a class="gh" href="https://github.com/known-life/life" target="_blank" rel="noopener">★ GitHub</a>
  </div>
</nav>`;
}

function footer(): string {
  return `<footer class="footer"><div class="wrap row">
    <span class="mk">Life</span>
    <span class="mono">a protocol for agent-legible repos · known.life</span>
  </div></footer>`;
}

function shell(title: string, inner: string, description = ""): string {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
${description ? `<meta name="description" content="${esc(description)}">` : ""}
${FONT}<style>${CSS}</style></head>
<body><div class="wrap">${nav()}${inner}</div>${footer()}</body></html>`;
}

export interface PackageView {
  pkg: PackageRecord;
  versions: VersionRecord[];
  dependents: string[];
  author: string | null;
  downloads: Record<string, number>;
  publisher: string | null;
  files?: Record<string, string>;
  filesMissing?: string[];
  viewerVersion?: string;
}

// "blessed" stays the on-the-wire value (DB, JSON, markdown). The HTML
// surface relabels it as "core" and renders every status as a tiny icon
// badge — ★ for core, ✓ for verified, nothing for plain "scanned".
function stateIcon(state: string | null | undefined): string {
  if (state === "blessed") return `<span class="b blessed" title="core" aria-label="core">★</span>`;
  if (state === "verified") return `<span class="b verified" title="verified" aria-label="verified">✓</span>`;
  return "";
}

// A package renamed/replaced by a successor: a small inline pill linking to it,
// so a reader of the listing or the gene page sees the live gene to use instead.
function supersededBadge(successor: string | null | undefined): string {
  if (!successor) return "";
  return ` <a class="superseded-by" title="superseded by ${esc(successor)}" href="/${esc(successor)}">⤳ ${esc(successor)}</a>`;
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function byteLen(s: string): number {
  return new TextEncoder().encode(s).length;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// --- lightweight, dependency-free syntax highlighter (server-side) ---
const KEYWORDS: Record<string, string> = {
  js: "const let var function return if else for while do switch case break continue new delete typeof instanceof void await async yield export import from default class extends super this null true false undefined in of try catch finally throw",
  sh: "if then else elif fi for while until do done case esac function in select return local export readonly set unset source",
  yaml: "true false null yes no",
  json: "true false null",
};

function langFor(path: string): string {
  if (path.endsWith(".life")) return "life";
  const m = path.toLowerCase().match(/\.([a-z0-9]+)$/);
  const ext = m ? m[1] : "";
  if (ext === "yaml" || ext === "yml") return "yaml";
  if (["js", "mjs", "cjs", "ts", "tsx", "jsx"].includes(ext)) return "js";
  if (["sh", "bash", "zsh"].includes(ext)) return "sh";
  if (ext === "json") return "json";
  if (ext === "md") return "md";
  return "txt";
}

function tokenize(code: string, lang: "js" | "sh" | "yaml" | "json"): string {
  const kw = new Set((KEYWORDS[lang] ?? "").split(/\s+/).filter(Boolean));
  const isYaml = lang === "yaml";
  const commentPat =
    lang === "js" ? String.raw`\/\*[\s\S]*?\*\/|\/\/[^\n]*` :
    lang === "sh" || isYaml ? String.raw`#[^\n]*` :
    String.raw`(?!)`;
  const re = new RegExp(
    `(${commentPat})` +
    String.raw`|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\`(?:\\.|[^\`\\])*\`)` +
    String.raw`|(\b\d[\d_]*(?:\.\d+)?\b)` +
    String.raw`|([A-Za-z_$][\w$-]*)` +
    String.raw`|(\s+)` +
    String.raw`|([\s\S])`,
    "g",
  );
  let out = "";
  let atLineStart = true;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    if (m[1] != null) { out += `<span class="hc">${esc(m[1])}</span>`; atLineStart = false; }
    else if (m[2] != null) { out += `<span class="hs">${esc(m[2])}</span>`; atLineStart = false; }
    else if (m[3] != null) { out += `<span class="hn">${esc(m[3])}</span>`; atLineStart = false; }
    else if (m[4] != null) {
      if (isYaml && atLineStart && code[re.lastIndex] === ":") out += `<span class="hk">${esc(m[4])}</span>`;
      else if (kw.has(m[4])) out += `<span class="hkw">${esc(m[4])}</span>`;
      else out += esc(m[4]);
      atLineStart = false;
    } else if (m[5] != null) {
      out += esc(m[5]);
      if (m[5].includes("\n")) atLineStart = true;
    } else {
      out += esc(m[6]);
      atLineStart = isYaml && m[6] === "-";
    }
    if (re.lastIndex === 0) break;
  }
  return out;
}

function highlight(code: string, lang: string): string {
  if (lang === "js" || lang === "sh" || lang === "yaml" || lang === "json") return tokenize(code, lang);
  if (lang === "life") {
    const fence = code.match(/\n---\n/);
    if (fence && fence.index != null) {
      const cut = fence.index + 1;
      return tokenize(code.slice(0, cut), "yaml") + esc(code.slice(cut));
    }
    return tokenize(code, "yaml");
  }
  return esc(code);
}

// --- minimal markdown → HTML, no dependencies. Handles headings, paragraphs,
// fenced code, inline code, links, lists, blockquotes, hr, bold/italic. Good
// enough for gene readmes without pulling a parser into the Worker. ---
function renderMarkdown(src: string): string {
  // Pull fenced code out first, replace with sentinels so inline rules don't
  // run inside them.
  const blocks: string[] = [];
  let s = src.replace(/\r\n/g, "\n").replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_m, lang, body) => {
    const language = (lang || "txt").toLowerCase();
    const known = ["js", "sh", "yaml", "json", "life"].includes(language) ? language : "txt";
    blocks.push(`<pre><code class="hl">${known === "txt" ? esc(body) : highlight(body, known)}</code></pre>`);
    return ` B${blocks.length - 1} `;
  });

  // Split on blank lines for block-level construction.
  const out: string[] = [];
  const paras = s.split(/\n{2,}/);
  for (let p of paras) {
    p = p.trim();
    if (!p) continue;
    if (/^ B\d+ $/.test(p)) { out.push(p); continue; }
    // headings
    const h = p.match(/^(#{1,6})\s+(.*)$/);
    if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    // hr
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(p)) { out.push("<hr>"); continue; }
    // blockquote
    if (/^>\s?/.test(p)) {
      const body = p.split("\n").map((l) => l.replace(/^>\s?/, "")).join("\n");
      out.push(`<blockquote>${inline(body).replace(/\n/g, "<br>")}</blockquote>`);
      continue;
    }
    // lists (ul or ol)
    if (/^([-*+]|\d+\.)\s+/.test(p)) {
      const ordered = /^\d+\.\s+/.test(p);
      const items = p.split(/\n(?=([-*+]|\d+\.)\s+)/).filter((x) => x && !/^([-*+]|\d+\.)$/.test(x));
      const lis = items.map((it) => `<li>${inline(it.replace(/^([-*+]|\d+\.)\s+/, ""))}</li>`).join("");
      out.push(ordered ? `<ol>${lis}</ol>` : `<ul>${lis}</ul>`);
      continue;
    }
    // paragraph
    out.push(`<p>${inline(p).replace(/\n/g, "<br>")}</p>`);
  }
  // restore fenced blocks
  return out.join("\n").replace(/ B(\d+) /g, (_m, i) => blocks[Number(i)]);
}

function inline(text: string): string {
  let t = esc(text);
  // inline code (do this first so we don't mangle * or _ inside)
  t = t.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
  // links [label](url)
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) => {
    const safe = /^(https?:\/\/|\/|#|mailto:)/i.test(url) ? url : "#";
    return `<a href="${safe}">${label}</a>`;
  });
  // bold
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // italic
  t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  return t;
}

const TAB_JS = `(function(){
var page=document.querySelector('.pkg-page');if(!page)return;
var tabs=page.querySelectorAll('.tab');
var panes=page.querySelectorAll('.pane');
function show(name){tabs.forEach(function(t){t.classList.toggle('active',t.dataset.tab===name)});
panes.forEach(function(p){p.classList.toggle('active',p.dataset.tab===name)});
try{history.replaceState(null,'','#'+name)}catch(_){};}
tabs.forEach(function(t){t.addEventListener('click',function(){show(t.dataset.tab)})});
var initial=(location.hash||'').replace('#','');
if(initial && page.querySelector('.tab[data-tab="'+initial.replace(/[^a-z]/g,'')+'"]'))show(initial);
})();
(function(){var root=document.querySelector('.files');if(!root)return;
var items=root.querySelectorAll('.fitem');
items.forEach(function(it){it.addEventListener('click',function(){
var i=it.getAttribute('data-i');
root.querySelectorAll('.fitem').forEach(function(x){x.classList.remove('active')});
root.querySelectorAll('.fpane').forEach(function(p){p.classList.remove('active')});
it.classList.add('active');
var pane=root.querySelector('.fpane[data-i="'+i+'"]');if(pane)pane.classList.add('active');});});
var vsel=root.querySelector('.vselect select');if(vsel)vsel.addEventListener('change',function(){if(vsel.value)location.href=vsel.value;});})();
document.querySelectorAll('.copy').forEach(function(btn){
var label=btn.querySelector('.copy-label');var original=label?label.textContent:'';
btn.addEventListener('click',function(){
var text=btn.getAttribute('data-copy')||'';
(navigator.clipboard?navigator.clipboard.writeText(text):Promise.reject()).catch(function(){
var ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';
document.body.appendChild(ta);ta.select();try{document.execCommand('copy')}catch(_){}ta.remove();});
btn.classList.add('copied');if(label)label.textContent='Copied';
setTimeout(function(){btn.classList.remove('copied');if(label)label.textContent=original},1400);});});`;

const MAX_FILE_CHARS = 60000;

function fileViewer(
  name: string,
  files: Record<string, string>,
  missing: string[],
  versions: VersionRecord[],
  viewerVersion: string,
): string {
  const paths = Object.keys(files).sort((a, b) => a.localeCompare(b));
  if (!paths.length && !missing.length) {
    return `<div class="empty">no files to show.</div>`;
  }

  // Versions are listed newest-first; a compact selector (latest preselected)
  // replaces the row of pills.
  const selector = versions.length > 1
    ? `<label class="vselect">version
        <select aria-label="Select version">${versions.map((x) => {
          const isLatest = x.version === versions[0]?.version;
          const href = isLatest ? `/${esc(name)}#code` : `/${esc(name)}?v=${encodeURIComponent(x.version)}#code`;
          const sel = x.version === viewerVersion ? " selected" : "";
          return `<option value="${esc(href)}"${sel}>${esc(x.version)}${isLatest ? " (latest)" : ""}${x.yanked ? " — deprecated" : ""}</option>`;
        }).join("")}</select>
      </label>`
    : "";

  const tree = paths
    .map((p, i) => `<button class="fitem${i === 0 ? " active" : ""}" data-i="${i}" type="button">${esc(p)}</button>`)
    .join("");

  const panes = paths
    .map((p, i) => {
      const raw = files[p];
      const bytes = byteLen(raw);
      const lang = langFor(p);
      const truncated = raw.length > MAX_FILE_CHARS;
      const body = highlight(truncated ? raw.slice(0, MAX_FILE_CHARS) : raw, lang === "md" ? "txt" : lang);
      const note = truncated
        ? `\n\n<span class="hc">… truncated (${fmtBytes(bytes)} total) — full source: /api/resolve/${esc(name)}/${esc(viewerVersion)}</span>`
        : "";
      return `<section class="fpane${i === 0 ? " active" : ""}" data-i="${i}">
        <div class="fhead">${esc(p)} · ${fmtBytes(bytes)} · ${lang === "txt" ? "text" : esc(lang)}</div>
        <pre><code class="hl">${body}${note}</code></pre></section>`;
    })
    .join("");

  const missNote = missing.length
    ? `<p class="miss">⚠ ${missing.length} file${missing.length === 1 ? "" : "s"} could not be loaded: ${missing.map(esc).join(", ")}</p>`
    : "";

  return `<div class="files">
    ${selector}
    <div class="fwrap"><nav class="ftree">${tree}</nav><div class="fpanes">${panes}</div></div>
    ${missNote}
    <noscript><style>.fpane{display:block !important;margin-bottom:14px}.ftree{display:none}</style></noscript>
  </div>`;
}

// --- agent markdown: unchanged decision surface ---
export function packageMarkdown(v: PackageView, publicUrl: string): string {
  const { pkg, versions } = v;
  const latest = versions.find((x) => x.version === pkg.latest_version) ?? versions[0];
  const requires = JSON.parse(latest?.requires_json ?? "[]") as string[];
  const provides = JSON.parse(latest?.provides_json ?? "[]") as string[];
  const keywords = JSON.parse(pkg.keywords_json ?? "[]") as string[];
  const fit = latest?.fit_json ? (JSON.parse(latest.fit_json) as { notes?: string[] }) : null;
  const history = versions
    .map((x) => `  - ${x.version} — ${fmtDate(x.published_at)} — ${v.downloads[x.version] ?? 0} installs${x.yanked ? " — DEPRECATED" : ""}`)
    .join("\n");
  return [
    `# ${pkg.name}`,
    pkg.description ? `\n> ${pkg.description}` : pkg.summary ? `\n> ${pkg.summary}` : "",
    `\n**install:** \`imports:\\n  - known.life/${pkg.name}\`  _(npm semantics: bare name floats to latest)_`,
    pkg.superseded_by ? `\n> ⤳ **Superseded by [${pkg.superseded_by}](/${pkg.superseded_by})** — inherit that instead.` : "",
    `\n- badge: **${pkg.verified_state}**`,
    `- latest: ${pkg.latest_version}`,
    `- total installs: ${pkg.install_count}`,
    v.publisher ? `- published by: @${v.publisher} (https://github.com/${v.publisher})` : "",
    v.author ? `- author: ${v.author}` : "",
    pkg.license ? `- license: ${pkg.license}` : "",
    keywords.length ? `- keywords: ${keywords.join(", ")}` : "",
    pkg.homepage ? `- homepage: ${pkg.homepage}` : "",
    pkg.repository ? `- repository: ${pkg.repository}` : "",
    provides.length ? `- provides: ${provides.join(", ")}` : "",
    requires.length ? `- requires: ${requires.join(", ")}` : "",
    v.dependents.length ? `- dependents: ${v.dependents.join(", ")}` : "",
    `\n## versions (publish history)\n${history}`,
    fit?.notes?.length ? `\n## fit notes\n${fit.notes.map((n) => `- ${n}`).join("\n")}` : "",
    pkg.readme ? `\n## readme\n${pkg.readme.slice(0, 3000)}` : latest?.contract ? `\n## contract\n${latest.contract.slice(0, 2000)}` : "",
    `\nResolve programmatically: \`GET ${publicUrl}/api/resolve/${pkg.name}/latest\``,
  ].filter(Boolean).join("\n");
}

// Keep the hero blurb short: prefer the first sentence, hard-capped. The
// long-form description lives in the readme / .life body, not the hero.
const MAX_SUMMARY = 160;
export function shortDesc(s: string | null | undefined): string {
  if (!s) return "";
  const t = s.trim().replace(/\s+/g, " ");
  const sentence = t.match(/^(.+?[.!?])(\s|$)/);
  let out = sentence && sentence[1].length <= MAX_SUMMARY ? sentence[1] : t;
  if (out.length > MAX_SUMMARY) out = out.slice(0, MAX_SUMMARY).replace(/\s+\S*$/, "") + "…";
  return out;
}

// --- human HTML: light pastel, npm-style sidebar + tabs ---
export function packageHtml(v: PackageView): string {
  const { pkg, versions } = v;
  const latest = versions.find((x) => x.version === pkg.latest_version) ?? versions[0];
  const requires = JSON.parse(latest?.requires_json ?? "[]") as string[];
  const provides = JSON.parse(latest?.provides_json ?? "[]") as string[];
  const keywords = JSON.parse(pkg.keywords_json ?? "[]") as string[];
  const heroSum = shortDesc(pkg.summary ?? pkg.description);
  // Natural-language install line; the copy appends a setup hint (not shown in
  // the box) for anyone who hasn't bootstrapped Life yet.
  const installCopy = `Install known.life/${pkg.name} (If you haven't set up Life yet, follow the setup instructions at known.life.)`;

  const readmeHtml = pkg.readme
    ? `<div class="prose">${renderMarkdown(pkg.readme)}</div>`
    : latest?.contract
      ? `<div class="prose"><h3>contract</h3><pre><code>${esc(latest.contract.slice(0, 4000))}</code></pre></div>`
      : `<div class="empty">no readme yet. publish a new version with a README to fill this in.</div>`;

  const versionHistory = `<details class="scard ver-history">
    <summary>version history <span class="vh-n">${versions.length}</span></summary>
    <div class="vh-list">${versions.map((x) => `<div class="vh-row">
      <a href="/${esc(pkg.name)}?v=${encodeURIComponent(x.version)}#code">${esc(x.version)}</a>
      <span class="d">${fmtDate(x.published_at)}</span>
      <span class="n">${(v.downloads[x.version] ?? 0).toLocaleString()}${x.yanked ? ` · <span class="dep">deprecated</span>` : ""}</span>
    </div>`).join("")}</div>
  </details>`;

  const dependentsPane = v.dependents.length
    ? `<div class="deps">${v.dependents.map((d) => `<a href="/${esc(d)}">${esc(d)}</a>`).join("")}</div>`
    : `<div class="empty">no published packages depend on this one yet.</div>`;

  const tabs: Array<{ id: string; label: string; count?: string; body: string }> = [
    { id: "readme", label: "Readme", body: readmeHtml },
    { id: "code", label: "Code", count: v.files ? String(Object.keys(v.files).length) : undefined,
      body: fileViewer(pkg.name, v.files ?? {}, v.filesMissing ?? [], versions, v.viewerVersion ?? pkg.latest_version ?? "") },
    { id: "dependents", label: "Dependents", count: v.dependents.length ? String(v.dependents.length) : undefined, body: dependentsPane },
  ];

  const tabNav = tabs.map((t, i) => `<button class="tab${i === 0 ? " active" : ""}" data-tab="${t.id}" type="button">${esc(t.label)}${t.count ? `<span class="ct">${esc(t.count)}</span>` : ""}</button>`).join("");
  const tabPanes = tabs.map((t, i) => `<section class="pane${i === 0 ? " active" : ""}" data-tab="${t.id}">${t.body}</section>`).join("");

  const inner = `
<header class="hero">
  <div class="crumbs"><a href="/explore">genepool</a> / gene</div>
  <div class="row">
    <div>
      <h1>${esc(pkg.name)}${stateIcon(pkg.verified_state)}</h1>
      ${pkg.superseded_by ? `<p class="superseded-banner">⤳ Superseded by <a href="/${esc(pkg.superseded_by)}">${esc(pkg.superseded_by)}</a> — inherit that instead.</p>` : ""}
      ${heroSum ? `<p class="sum">${esc(heroSum)}</p>` : ""}
      ${keywords.length ? `<div class="pills">${keywords.map((k) => `<span class="pill kw">${esc(k)}</span>`).join("")}</div>` : ""}
    </div>
  </div>
</header>

<div class="cols pkg-page">
  <main class="main">
    <div class="tabs" role="tablist">${tabNav}</div>
    ${tabPanes}
  </main>

  <aside class="side">
    <div class="scard install">
      <h4>install</h4>
      <p class="install-say">Install <b>known.life/${esc(pkg.name)}</b></p>
      <button class="copy" type="button" data-copy="${esc(installCopy)}">${COPY_ICON}<span class="copy-label">Copy for agent</span></button>
    </div>

    <div class="scard">
      <div class="odo">${pkg.install_count.toLocaleString()}<small>installs</small></div>
      <div style="margin-top:14px">
        <div class="kv"><span class="k">version</span><span class="v">${esc(pkg.latest_version ?? "—")}</span></div>
        <div class="kv"><span class="k">published</span><span class="v">${latest ? fmtDate(latest.published_at) : "—"}</span></div>
        ${latest?.bytes ? `<div class="kv"><span class="k">unpacked</span><span class="v">${fmtBytes(latest.bytes)}</span></div>` : ""}
        ${pkg.license ? `<div class="kv"><span class="k">license</span><span class="v">${esc(pkg.license)}</span></div>` : ""}
      </div>
    </div>

    <div class="scard">
      <h4>links</h4>
      ${v.publisher ? `<div class="kv"><span class="k">published by</span><span class="v"><a href="https://github.com/${esc(v.publisher)}" target="_blank" rel="noopener">@${esc(v.publisher)}</a></span></div>` : ""}
      ${v.author ? `<div class="kv"><span class="k">author</span><span class="v">${esc(v.author)}</span></div>` : ""}
      ${pkg.repository ? `<div class="kv"><span class="k">repository</span><span class="v"><a href="${esc(pkg.repository)}" target="_blank" rel="noopener">${esc(pkg.repository.replace(/^https?:\/\//, ""))}</a></span></div>` : ""}
      ${pkg.homepage ? `<div class="kv"><span class="k">homepage</span><span class="v"><a href="${esc(pkg.homepage)}" target="_blank" rel="noopener">${esc(pkg.homepage.replace(/^https?:\/\//, ""))}</a></span></div>` : ""}
      <div class="kv"><span class="k">resolve</span><span class="v"><a href="/api/resolve/${esc(pkg.name)}/latest"><code style="font-size:11.5px">/api/resolve</code></a></span></div>
    </div>

    <div class="scard">
      <h4>provides</h4>
      <div class="caplist">${provides.length ? provides.map((p) => `<code>${esc(p)}</code>`).join("") : `<span class="none">no capabilities declared</span>`}</div>
    </div>

    <div class="scard">
      <h4>requires</h4>
      <div class="caplist">${requires.length ? requires.map((r) => `<code>${esc(r)}</code>`).join("") : `<span class="none">no dependencies</span>`}</div>
    </div>

    ${versions.length > 1 ? versionHistory : ""}
  </aside>
</div>
<script>${TAB_JS}</script>`;

  return shell(`${pkg.name} — known.life`, inner, pkg.description ?? pkg.summary ?? "");
}

// --- explore / search listings — same pastel palette ---
export function listHtml(title: string, rows: PackageRecord[], query = ""): string {
  const isSearch = title.toLowerCase().startsWith("search");
  const heading = isSearch
    ? (query ? `Results for &ldquo;${esc(query)}&rdquo;` : `Search`)
    : `Genes`;
  const sub = isSearch
    ? (query ? `${rows.length} match${rows.length === 1 ? "" : "es"}.` : `Find a gene by name, capability, or keyword.`)
    : `${rows.length} gene${rows.length === 1 ? "" : "s"}, ranked by installs.`;
  const rowsHtml = rows.length === 0
    ? `<tr class="empty-row"><td colspan="4">no genes match.</td></tr>`
    : rows.map((p) => `<tr${p.superseded_by ? ' class="superseded"' : ""}>
        <td data-label="gene"><a class="nm" href="/${esc(p.name)}">${esc(p.name)}</a>${stateIcon(p.verified_state)}${supersededBadge(p.superseded_by)}</td>
        <td data-label="version"><span class="ver">${esc(p.latest_version ?? "")}</span></td>
        <td data-label="summary"><span class="sum">${esc(shortDesc(p.summary ?? p.description))}</span></td>
        <td class="num ct" data-label="installs">${p.install_count.toLocaleString()}</td>
      </tr>`).join("");
  const inner = `
<header class="list-head">
  <h1>${heading}</h1>
  <p class="lead">${sub}</p>
  <form class="search-big" action="/search" method="get" role="search">
    ${SEARCH_ICON}
    <input type="search" name="q" value="${esc(query)}" placeholder="search by name, capability, keyword…" aria-label="Search">
  </form>
</header>
<table class="pkg-table">
  <thead><tr><th>gene</th><th>version</th><th>summary</th><th class="num">installs</th></tr></thead>
  <tbody>${rowsHtml}</tbody>
</table>`;
  return shell(`${title} — known.life`, inner);
}

export function listMarkdown(title: string, rows: PackageRecord[]): string {
  return (
    `# ${title}\n\n` +
    rows
      .map((p) => {
        const tag = p.superseded_by ? ` — ⤳ superseded by **${p.superseded_by}**` : "";
        return `- **${p.name}**@${p.latest_version} — ${p.install_count} installs${tag} — ${p.summary ?? ""}`;
      })
      .join("\n") +
    (rows.length ? "" : "\n_(empty)_")
  );
}

export function landingHtml(): string {
  const inner = `
<header class="list-head">
  <h1>known.life</h1>
  <p class="lead">A genepool of versioned, signed genes for Life-aware agents. Install by name, from any harness.</p>
  <form class="search-big" action="/search" method="get" role="search">
    ${SEARCH_ICON}
    <input type="search" name="q" placeholder="search packages…" aria-label="Search">
  </form>
</header>
<div style="padding:20px 0">
  <p><a href="/explore">Browse all genes →</a> · <a href="/docs">Read the spec →</a> · <a href="/skill">Publish a gene →</a></p>
</div>`;
  return shell("known.life — the genepool for .life", inner);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
