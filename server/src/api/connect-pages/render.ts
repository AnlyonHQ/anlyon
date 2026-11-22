import { LOGOS } from "./logos.ts";

export type Tone = "neutral" | "success" | "warning" | "error";
type IconName = keyof typeof ICONS;

export interface ConnectPageField {
  name: string;
  label: string;
  hint?: string;
  secret: boolean;
}

export interface ConnectPageView {
  status: 200 | 400 | 404 | 410 | 501 | 502;
  heading: string;
  lead?: string;
  hero:
    | { kind: "pair"; integration: { id: string; name: string }; app: string | null; connected?: boolean }
    | { kind: "status"; tone: Tone; icon: "clock" | "alert" | "check" | "x" | "unplug" | "search" };
  facts?: Array<{ icon: "lock" | "eye-off" | "unlink" | "shield" | "info"; text: string }>;
  alert?: { title: string; detail?: string };
  form?: {
    action: string;
    token: string;
    fields: ConnectPageField[];
    submit: string;
    help?: { text: string; href?: string };
  };
  caution?: string;
  primary?: { href: string; label: string };
  secondary?: { href: string; label: string };
  formTargets?: string[];
}

export const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const ORIGIN = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$|^https?:\/\/\[[0-9A-Fa-f:.]+\](?::\d{1,5})?$/;

export function connectPageCsp(view: ConnectPageView): string {
  const targets = (view.formTargets ?? []).filter((origin) => ORIGIN.test(origin));
  const formAction = view.form ? ["'self'", ...new Set(targets)].join(" ") : "'none'";
  return `default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action ${formAction}; frame-ancestors 'none'`;
}

const ICONS = {
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  "eye-off": '<path d="M9.9 9.9a3 3 0 1 0 4.2 4.2"/><path d="M10.7 5.1A10.4 10.4 0 0 1 12 5c7 0 10 7 10 7a13.2 13.2 0 0 1-1.7 2.7"/><path d="M6.6 6.6A13.5 13.5 0 0 0 2 12s3 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="m2 2 20 20"/>',
  unlink: '<path d="m18.8 12.3 1.7-1.7a5 5 0 0 0-7.1-7.1l-1.7 1.7"/><path d="m5.2 11.7-1.7 1.8a5 5 0 0 0 7.1 7l1.7-1.7"/><path d="M8 2v3M2 8h3M16 19v3M19 16h3"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.7 9a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  info: '<circle cx="12" cy="12" r="9.5"/><path d="M12 16v-4.5M12 8h.01"/>',
  clock: '<circle cx="12" cy="12" r="9.5"/><path d="M12 7v5l3 2"/>',
  alert: '<circle cx="12" cy="12" r="9.5"/><path d="M12 7.5v5M12 16.2h.01"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  unplug: '<path d="m19 5 3-3M2 22l3-3"/><path d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z"/><path d="M7.5 13.5 10 11M10.5 16.5 13 14"/><path d="m12 6 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  arrows: '<path d="M7 4 3 8l4 4"/><path d="M3 8h18"/><path d="m17 20 4-4-4-4"/><path d="M21 16H3"/>',
  arrow: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  external: '<path d="M8 8h8v8"/><path d="M8 16 16 8"/>',
} as const;

const icon = (name: IconName, className = "icon") =>
  `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;

const ANLYON_MARK =
  '<svg class="mark" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" focusable="false"><path d="M17.8374 62.8178C26.9965 47.3385 39.3151 33.9633 53.99 23.564C68.665 13.1647 85.3668 5.97495 103.007 2.46333C120.647 -1.04829 138.829 -0.8029 156.367 3.18351C173.906 7.16993 190.408 14.8079 204.797 25.5994C219.186 36.3909 231.139 50.0937 239.877 65.8146C248.615 81.5354 253.942 98.9213 255.51 116.839C257.078 134.756 254.853 152.803 248.979 169.803C243.105 186.803 233.714 202.374 221.419 215.501L17.8374 62.8178Z"/><path d="M9.2025 80.341L118.399 162.238V255.637C98.3398 254.128 78.9184 247.913 61.7101 237.495C44.5019 227.077 29.9913 212.75 19.3552 195.675C8.71912 178.601 2.25706 159.26 0.493095 139.222C-1.27087 119.183 1.71293 99.0109 9.2025 80.341Z"/><path d="M137.599 176.638L207.014 228.698C187.056 244.358 162.896 253.734 137.599 255.637V176.638Z"/></svg>';

const LOGO_ALIASES: Record<string, string> = { "linear-key": "linear" };

const initial = (name: string) => escapeHtml((Array.from(name.trim())[0] ?? "?").toUpperCase());

function integrationTile(integration: { id: string; name: string }): string {
  const logo = LOGOS[LOGO_ALIASES[integration.id] ?? integration.id];
  return `<span class="tile brand" title="${escapeHtml(integration.name)}">${logo ?? `<span class="letter">${initial(integration.name)}</span>`}</span>`;
}

function appTile(app: string | null): string {
  return app === null
    ? `<span class="tile app anlyon" title="Anlyon">${ANLYON_MARK}</span>`
    : `<span class="tile app" title="${escapeHtml(app)}"><span class="letter">${initial(app)}</span></span>`;
}

function hero(view: ConnectPageView): string {
  if (view.hero.kind === "status") {
    return `<div class="hero"><span class="status ${view.hero.tone}">${icon(view.hero.icon, "status-icon")}</span></div>`;
  }
  const { integration, app, connected } = view.hero;
  const joint = connected
    ? `<span class="joint done">${icon("check", "joint-icon")}</span>`
    : `<span class="joint">${icon("arrows", "joint-icon")}</span>`;
  return `<div class="hero pair">${integrationTile(integration)}<span class="bridge${connected ? " done" : ""}" aria-hidden="true"><i></i>${joint}<i></i></span>${appTile(app)}</div>`;
}

function form(view: ConnectPageView): string {
  if (!view.form) return "";
  const { action, token, fields, submit, help } = view.form;
  const inputs = fields.map((field, index) => {
    const id = `f${index}`;
    return `<div class="field"><label for="${id}">${escapeHtml(field.label)}</label>${field.hint ? `<p class="hint" id="${id}h">${escapeHtml(field.hint)}</p>` : ""}<input id="${id}" name="f_${escapeHtml(field.name)}" type="${field.secret ? "password" : "text"}" required autocomplete="off" autocapitalize="off" spellcheck="false"${field.hint ? ` aria-describedby="${id}h"` : ""}${index === 0 ? " autofocus" : ""}></div>`;
  }).join("");
  const helpLine = help
    ? `<p class="help">${escapeHtml(help.text)}${help.href ? ` <a href="${escapeHtml(help.href)}" rel="noreferrer noopener" target="_blank">Where to find it${icon("external", "inline-icon")}</a>` : ""}</p>`
    : "";
  return `<form method="post" action="${escapeHtml(action)}" autocomplete="off"><input type="hidden" name="token" value="${escapeHtml(token)}">${inputs}${helpLine}<button class="button" type="submit">${escapeHtml(submit)}</button></form>`;
}

export function renderConnectPage(view: ConnectPageView): string {
  const facts = view.facts?.length
    ? `<ul class="facts">${view.facts.map((fact) => `<li>${icon(fact.icon, "fact-icon")}<span>${escapeHtml(fact.text)}</span></li>`).join("")}</ul>`
    : "";
  const alert = view.alert
    ? `<div class="alert" role="alert">${icon("alert", "alert-icon")}<div><p class="alert-title">${escapeHtml(view.alert.title)}</p>${view.alert.detail ? `<p>${escapeHtml(view.alert.detail)}</p>` : ""}</div></div>`
    : "";
  const caution = view.caution ? `<p class="caution">${escapeHtml(view.caution)}</p>` : "";
  const primary = view.primary
    ? `<a class="button" href="${escapeHtml(view.primary.href)}" rel="noreferrer">${escapeHtml(view.primary.label)}${icon("arrow", "button-icon")}</a>`
    : "";
  const secondary = view.secondary
    ? `<a class="quiet" href="${escapeHtml(view.secondary.href)}" rel="noreferrer">${escapeHtml(view.secondary.label)}</a>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(view.heading)} · Anlyon</title>
<style>${STYLE}</style>
</head>
<body>
<main class="shell">
<section class="card" aria-labelledby="heading">
${hero(view)}
<h1 id="heading">${escapeHtml(view.heading)}</h1>
${view.lead ? `<p class="lead">${escapeHtml(view.lead)}</p>` : ""}
${facts}${alert}${view.form ? caution + form(view) : caution}${primary || secondary ? `<div class="actions">${primary}${secondary}</div>` : ""}
</section>
<footer class="secured">Secured by ${ANLYON_MARK}<span>Anlyon</span></footer>
</main>
</body>
</html>`;
}

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #f4f4f5;
  --bg-glow: #ffffff;
  --card: #ffffff;
  --card-border: rgba(9, 9, 11, .08);
  --card-shadow: 0 1px 2px rgba(9, 9, 11, .04), 0 16px 40px -16px rgba(9, 9, 11, .14);
  --text: #09090b;
  --text-2: #3f3f46;
  --muted: #71717a;
  --hair: rgba(9, 9, 11, .07);
  --panel: #fafafa;
  --tile-border: rgba(9, 9, 11, .1);
  --dash: rgba(9, 9, 11, .22);
  --app-tile: linear-gradient(160deg, #3f3f46 0%, #18181b 100%);
  --app-ink: #fafafa;
  --button: #18181b;
  --button-hover: #27272a;
  --button-ink: #fafafa;
  --input: #ffffff;
  --input-border: rgba(9, 9, 11, .14);
  --focus: rgba(24, 24, 27, .16);
  --ok: #16a34a; --ok-soft: rgba(22, 163, 74, .1);
  --warn: #b45309; --warn-soft: rgba(217, 119, 6, .1);
  --bad: #dc2626; --bad-soft: rgba(220, 38, 38, .08); --bad-line: rgba(220, 38, 38, .22); --bad-ink: #b91c1c;
  --neutral-soft: rgba(9, 9, 11, .05);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #09090b;
    --bg-glow: #18181b;
    --card: #111113;
    --card-border: rgba(255, 255, 255, .08);
    --card-shadow: 0 0 0 1px rgba(0, 0, 0, .4), 0 24px 56px -24px rgba(0, 0, 0, .8);
    --text: #fafafa;
    --text-2: #d4d4d8;
    --muted: #a1a1aa;
    --hair: rgba(255, 255, 255, .07);
    --panel: #18181b;
    --tile-border: rgba(255, 255, 255, .1);
    --dash: rgba(255, 255, 255, .24);
    --app-tile: linear-gradient(160deg, #3f3f46 0%, #27272a 100%);
    --button: #fafafa;
    --button-hover: #e4e4e7;
    --button-ink: #09090b;
    --input: #09090b;
    --input-border: rgba(255, 255, 255, .14);
    --focus: rgba(250, 250, 250, .18);
    --ok: #22c55e; --ok-soft: rgba(34, 197, 94, .12);
    --warn: #f59e0b; --warn-soft: rgba(245, 158, 11, .12);
    --bad: #f87171; --bad-soft: rgba(248, 113, 113, .08); --bad-line: rgba(248, 113, 113, .25); --bad-ink: #fca5a5;
    --neutral-soft: rgba(255, 255, 255, .06);
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  min-height: 100vh;
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: 40px 16px;
  background: radial-gradient(900px 520px at 50% -8%, var(--bg-glow), transparent 70%), var(--bg);
  color: var(--text);
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", system-ui, Roboto, "Helvetica Neue", Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
.shell { width: 100%; max-width: 420px; }
.card {
  background: var(--card);
  border: 1px solid var(--card-border);
  border-radius: 18px;
  box-shadow: var(--card-shadow);
  padding: 36px 32px 28px;
  text-align: center;
}
.hero { display: flex; justify-content: center; align-items: center; margin-bottom: 24px; }
.tile {
  width: 56px; height: 56px; flex: none;
  display: grid; place-items: center;
  border-radius: 15px;
  box-shadow: 0 1px 2px rgba(9, 9, 11, .06);
}
.tile.brand { background: #fff; border: 1px solid var(--tile-border); }
.tile.brand svg { width: 28px; height: 28px; }
.tile.brand .letter { color: #18181b; }
.tile.app { background: var(--app-tile); color: var(--app-ink); border: 1px solid var(--tile-border); }
.tile.app .mark { width: 26px; height: 26px; }
.letter { font-size: 23px; font-weight: 600; letter-spacing: -.02em; line-height: 1; }
.bridge { display: flex; align-items: center; gap: 6px; width: 92px; padding: 0 8px; }
.bridge i { flex: 1; height: 0; border-top: 1.5px dashed var(--dash); }
.bridge.done i { border-top-style: solid; border-color: var(--ok); opacity: .45; }
.joint {
  width: 26px; height: 26px; flex: none;
  display: grid; place-items: center;
  border-radius: 999px;
  background: var(--card);
  border: 1px solid var(--tile-border);
  color: var(--muted);
}
.joint.done { background: var(--ok); border-color: var(--ok); color: #fff; }
.joint-icon { width: 13px; height: 13px; }
.joint.done .joint-icon { stroke-width: 2.5; }
.status { width: 52px; height: 52px; display: grid; place-items: center; border-radius: 999px; }
.status-icon { width: 24px; height: 24px; }
.status.neutral { background: var(--neutral-soft); color: var(--text-2); }
.status.success { background: var(--ok-soft); color: var(--ok); }
.status.warning { background: var(--warn-soft); color: var(--warn); }
.status.error { background: var(--bad-soft); color: var(--bad); }
h1 { margin: 0; font-size: 21px; line-height: 1.3; font-weight: 600; letter-spacing: -.018em; text-wrap: balance; }
.lead { margin: 8px auto 0; max-width: 38ch; color: var(--muted); font-size: 14.5px; text-wrap: pretty; }
.facts {
  list-style: none; margin: 24px 0 0; padding: 4px 16px;
  text-align: left;
  background: var(--panel);
  border: 1px solid var(--hair);
  border-radius: 12px;
}
.facts li { display: flex; gap: 12px; align-items: flex-start; padding: 10px 0; font-size: 13.5px; line-height: 1.45; color: var(--text-2); }
.facts li + li { border-top: 1px solid var(--hair); }
.fact-icon { width: 16px; height: 16px; flex: none; margin-top: 1.5px; color: var(--muted); }
.alert {
  display: flex; gap: 10px; align-items: flex-start;
  margin: 24px 0 0; padding: 12px 14px;
  text-align: left; font-size: 13.5px;
  background: var(--bad-soft); border: 1px solid var(--bad-line); border-radius: 12px;
  color: var(--bad-ink);
}
.alert p { margin: 0; }
.alert p + p { margin-top: 2px; opacity: .9; }
.alert-title { font-weight: 550; }
.alert-icon { width: 17px; height: 17px; flex: none; margin-top: 1.5px; }
form { margin: 24px 0 0; text-align: left; display: grid; gap: 16px; }
.field { display: grid; gap: 6px; }
label { font-size: 13.5px; font-weight: 550; color: var(--text); }
.hint { margin: -2px 0 0; font-size: 12.5px; color: var(--muted); }
input[type="text"], input[type="password"] {
  width: 100%; height: 44px; padding: 0 13px;
  font: inherit; font-size: 15px; color: var(--text);
  background: var(--input); border: 1px solid var(--input-border); border-radius: 10px;
  outline: none; transition: border-color .15s, box-shadow .15s;
}
input:focus { border-color: var(--text); box-shadow: 0 0 0 4px var(--focus); }
.help { margin: -4px 0 0; font-size: 12.5px; color: var(--muted); }
.help a { color: var(--text-2); font-weight: 500; text-decoration: none; border-bottom: 1px solid var(--hair); white-space: nowrap; }
.help a:hover { border-color: currentColor; }
.inline-icon { width: 12px; height: 12px; margin-left: 2px; vertical-align: -1px; }
.caution { margin: 20px auto 0; max-width: 42ch; font-size: 13px; color: var(--muted); text-wrap: pretty; }
.actions { display: grid; gap: 4px; margin-top: 20px; }
form + .actions { margin-top: 8px; }
.button {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  width: 100%; height: 46px; padding: 0 18px;
  font: inherit; font-size: 15px; font-weight: 550; letter-spacing: -.005em;
  color: var(--button-ink); background: var(--button);
  border: 0; border-radius: 11px; cursor: pointer; text-decoration: none;
  box-shadow: 0 1px 2px rgba(9, 9, 11, .12), inset 0 1px 0 rgba(255, 255, 255, .08);
  transition: background .15s, transform .05s;
}
.button:hover { background: var(--button-hover); }
.button:active { transform: translateY(.5px); }
.button-icon { width: 16px; height: 16px; }
.quiet {
  display: inline-flex; align-items: center; justify-content: center;
  height: 38px; font-size: 14px; color: var(--muted); text-decoration: none; border-radius: 10px;
}
.quiet:hover { color: var(--text); }
a:focus-visible, button:focus-visible { outline: 2px solid var(--text); outline-offset: 3px; }
.secured {
  display: flex; align-items: center; justify-content: center; gap: 6px;
  margin-top: 20px; font-size: 12.5px; color: var(--muted);
}
.secured .mark { width: 14px; height: 14px; color: var(--text-2); }
.secured span { color: var(--text-2); font-weight: 600; letter-spacing: -.01em; margin-left: -2px; }
@media (max-width: 440px) {
  body { padding: 24px 16px; place-items: start center; padding-top: max(32px, 8vh); }
  .card { padding: 28px 22px 22px; border-radius: 16px; }
  .bridge { width: 76px; }
  h1 { font-size: 20px; }
}
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;
