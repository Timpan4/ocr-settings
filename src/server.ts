import { ConflictError, type SettingsStore } from "./github";
import { changedKeys, EFFORTS, MAX_TIMEOUT_MINUTES, parseForm, type Settings, SettingsError } from "./settings";

export interface HandlerOptions {
  store: SettingsStore;
  /** Public origin, e.g. https://ocr.timpan.dev. POSTs from any other origin are refused. */
  publicOrigin: string;
  /** Repository shown on the page, e.g. Timpan4/ocr-review. */
  repoLabel: string;
}

const BASE = "/settings/";
const COMMIT_SHA = /^[0-9a-f]{40}$/;

const DEFAULTS: Settings = {
  model: "gpt-6.1-sol",
  effort: "",
  noFilter: false,
  exclude: [],
  maxTokensBudget: 0,
  timeoutMinutes: 15,
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

interface PageState {
  settings: Settings;
  sha: string;
  repoLabel: string;
  notice?: { kind: "ok" | "error"; html: string };
}

function page({ settings, sha, repoLabel, notice }: PageState): string {
  const effortOptions = EFFORTS.map((effort) => {
    const label = effort === "" ? "OCR default" : effort;
    const selected = effort === settings.effort ? " selected" : "";
    return `<option value="${effort}"${selected}>${label}</option>`;
  }).join("");
  const banner = notice
    ? `<p class="notice ${notice.kind}" role="${notice.kind === "error" ? "alert" : "status"}">${notice.html}</p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OCR settings</title>
<style>
  :root { color-scheme: light dark; --fg: #1f2328; --muted: #59636e; --bg: #fff; --line: #d1d9e0; --ok: #1a7f37; --err: #cf222e; }
  @media (prefers-color-scheme: dark) { :root { --fg: #f0f6fc; --muted: #9198a1; --bg: #0d1117; --line: #3d444d; --ok: #3fb950; --err: #f85149; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
  main { max-width: 40rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  .sub { color: var(--muted); margin: 0 0 1.5rem; }
  label { display: block; font-weight: 600; margin-top: 1.25rem; }
  .hint { color: var(--muted); font-size: .875rem; margin: .15rem 0 .4rem; }
  input[type=text], input[type=number], select, textarea { width: 100%; box-sizing: border-box; padding: .45rem .6rem; font: inherit; color: inherit; background: transparent; border: 1px solid var(--line); border-radius: 6px; }
  textarea { min-height: 6rem; font-family: ui-monospace, monospace; }
  .check { display: flex; gap: .5rem; align-items: center; font-weight: 600; margin-top: 1.25rem; }
  button { margin-top: 1.75rem; padding: .55rem 1.1rem; font: inherit; font-weight: 600; border: 1px solid var(--line); border-radius: 6px; background: var(--fg); color: var(--bg); cursor: pointer; }
  .notice { padding: .6rem .8rem; border-radius: 6px; border: 1px solid; }
  .notice.ok { border-color: var(--ok); } .notice.error { border-color: var(--err); }
  a { color: inherit; }
</style>
</head>
<body>
<main>
<h1>OCR review settings</h1>
<p class="sub">Shared by every repository. Saving commits <code>settings.json</code> to <code>main</code> in <a href="https://github.com/${escapeHtml(repoLabel)}/blob/main/settings.json">${escapeHtml(repoLabel)}</a>; the next review uses it. <a href="/">Review history</a></p>
${banner}
<form method="post" action="${BASE}">
<input type="hidden" name="sha" value="${escapeHtml(sha)}">
<label for="model">Model</label>
<p class="hint" id="model-hint">ChatGPT model for the Sign in with ChatGPT provider.</p>
<input type="text" id="model" name="model" required value="${escapeHtml(settings.model)}" aria-describedby="model-hint" autocomplete="off" spellcheck="false">
<label for="effort">Review effort</label>
<p class="hint" id="effort-hint"><code>ocr review --effort</code>. OCR's default is medium.</p>
<select id="effort" name="effort" aria-describedby="effort-hint">${effortOptions}</select>
<label class="check"><input type="checkbox" name="noFilter"${settings.noFilter ? " checked" : ""}><span>Keep all comments (<code>--no-filter</code>)</span></label>
<p class="hint">Skips OCR's LLM post-filtering, so reviews post more comments.</p>
<label for="exclude">Exclude patterns</label>
<p class="hint" id="exclude-hint">One gitignore-style pattern per line. Merged with each repository's <code>rule.json</code> excludes.</p>
<textarea id="exclude" name="exclude" aria-describedby="exclude-hint" spellcheck="false">${escapeHtml(settings.exclude.join("\n"))}</textarea>
<label for="maxTokensBudget">Token budget per review</label>
<p class="hint" id="budget-hint"><code>--max-tokens-budget</code>. A soft limit checked before each LLM round: a group already over it gets one final round. 0 means no budget.</p>
<input type="number" id="maxTokensBudget" name="maxTokensBudget" min="0" step="1" required value="${settings.maxTokensBudget}" aria-describedby="budget-hint">
<label for="timeoutMinutes">Timeout per review group (minutes)</label>
<p class="hint" id="timeout-hint"><code>--timeout</code>, multiplied by the template's review rounds. OCR's default is 15. 0 means no limit; the job itself stops at 60 minutes.</p>
<input type="number" id="timeoutMinutes" name="timeoutMinutes" min="0" max="${MAX_TIMEOUT_MINUTES}" step="1" required value="${settings.timeoutMinutes}" aria-describedby="timeout-hint">
<button type="submit">Save and commit</button>
</form>
</main>
</body>
</html>`;
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
    },
  });
}

/** oauth2-proxy may forward the path with or without the /settings prefix. */
function routePath(url: URL): string {
  const path = url.pathname.startsWith("/settings") ? url.pathname.slice("/settings".length) : url.pathname;
  return path === "" ? "/" : path;
}

function signedInUser(request: Request): string {
  return (
    request.headers.get("x-forwarded-email") ??
    request.headers.get("x-forwarded-preferred-username") ??
    request.headers.get("x-forwarded-user") ??
    "unknown user"
  );
}

export function createHandler({ store, publicOrigin, repoLabel }: HandlerOptions) {
  async function show(notice?: PageState["notice"], status = 200): Promise<Response> {
    const file = await store.read();
    const problem = file.problem
      ? { kind: "error" as const, html: `The committed settings.json is invalid: ${escapeHtml(file.problem)} Saving replaces it.` }
      : undefined;
    return html(page({ settings: file.settings ?? DEFAULTS, sha: file.sha, repoLabel, notice: notice ?? problem }), status);
  }

  async function save(request: Request): Promise<Response> {
    if (request.headers.get("origin") !== publicOrigin) {
      return new Response("Forbidden: cross-origin form submission.", { status: 403 });
    }
    const form = await request.formData();
    const sha = String(form.get("sha") ?? "");
    let next: Settings;
    try {
      next = parseForm(form);
    } catch (error) {
      if (!(error instanceof SettingsError)) throw error;
      const file = await store.read();
      return html(
        page({
          settings: file.settings ?? DEFAULTS,
          sha: file.sha,
          repoLabel,
          notice: { kind: "error", html: `Not saved: ${escapeHtml(error.message)}` },
        }),
        400,
      );
    }
    const current = await store.read();
    if (current.sha !== sha) {
      return show({ kind: "error", html: "Not saved: settings.json changed on GitHub after you opened this page. These are the current values." }, 409);
    }
    const changed = current.settings ? changedKeys(current.settings, next) : ["settings.json"];
    if (changed.length === 0) {
      return Response.redirect(`${publicOrigin}${BASE}?unchanged=1`, 303);
    }
    const message = `chore(settings): update ${changed.join(", ")}\n\nSaved by ${signedInUser(request)} on ${publicOrigin}${BASE}`;
    try {
      const commit = await store.write(next, sha, message);
      return Response.redirect(`${publicOrigin}${BASE}?saved=${commit.sha}`, 303);
    } catch (error) {
      if (error instanceof ConflictError) {
        return show({ kind: "error", html: `Not saved: ${escapeHtml(error.message)} These are the current values.` }, 409);
      }
      throw error;
    }
  }

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = routePath(url);
    if (path === "/healthz" && request.method === "GET") return new Response("ok");
    if (path !== "/") return new Response("Not found", { status: 404 });
    if (request.method === "POST") return save(request);
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
    const saved = url.searchParams.get("saved");
    if (saved && COMMIT_SHA.test(saved)) {
      const link = `https://github.com/${escapeHtml(repoLabel)}/commit/${saved}`;
      return show({ kind: "ok", html: `Saved as <a href="${link}">${saved.slice(0, 7)}</a>. The next review uses these settings.` });
    }
    if (url.searchParams.has("unchanged")) return show({ kind: "ok", html: "Nothing changed, so nothing was committed." });
    return show();
  };
}
