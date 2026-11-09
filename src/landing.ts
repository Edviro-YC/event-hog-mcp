// The public front door: a page anyone can open, copy one prompt from, and
// paste into their agent. The prompt carries a personal connector URL whose
// key is minted in the browser; the server only learns of it on first use
// (resolvePerson creates the member then).

const KEY_PLACEHOLDER = "__EVENTHOG_URL__";

function connectPrompt(): string {
  const u = KEY_PLACEHOLDER;
  return [
    "Connect me to EventHog, a shared workspace for working a conference: prep before, contacts during, follow-ups after.",
    "",
    "My personal EventHog connector URL is:",
    u,
    "It works like a password. Don't share it or post it anywhere.",
    "",
    'Step 1. Add it as a remote MCP server (Streamable HTTP, no sign-in) named "event-hog". Use whichever applies to you:',
    `- Cursor: add "event-hog": { "url": "${u}" } under "mcpServers" in ~/.cursor/mcp.json (merge with what's there; create the file if it's missing). If the tools don't show up, tell me to toggle event-hog on in Cursor Settings > MCP.`,
    `- Claude Code: run  claude mcp add --transport http event-hog ${u}`,
    `- Codex: add these two lines to ~/.codex/config.toml:  [mcp_servers.event-hog]  and  url = "${u}"`,
    "- Claude (web, desktop or mobile), ChatGPT, or any app where you can't add servers yourself: walk me through it, one step at a time. In Claude it's Settings > Connectors > Add custom connector, name it EventHog, paste the URL, then Add. I'll come back and say \"done\".",
    "",
    'Step 2. Once EventHog\'s tools are available, call its get_started tool and follow what it says. If they don\'t appear in this chat, tell me to start a new chat and say "Use EventHog: get started".',
  ].join("\n");
}

const STYLE = `
  :root { color-scheme: light dark; --ink: #1d1b16; --muted: #6b665c; --paper: #faf7f0; --card: #fff; --line: #e6e0d2; --accent: #c2410c; }
  @media (prefers-color-scheme: dark) { :root { --ink: #f3efe6; --muted: #a8a196; --paper: #15130f; --card: #1f1c17; --line: #36312a; --accent: #fb923c; } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--paper); color: var(--ink); }
  main { max-width: 720px; margin: 0 auto; padding: 48px 20px 64px; }
  h1 { font-size: 40px; line-height: 1.1; margin: 0 0 8px; letter-spacing: -0.02em; }
  .lede { font-size: 19px; color: var(--muted); margin: 0 0 32px; }
  .phases { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; margin: 0 0 32px; }
  .phase { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
  .phase b { display: block; color: var(--accent); font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 4px; }
  .step { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 20px; margin: 0 0 16px; }
  .step h2 { font-size: 18px; margin: 0 0 6px; }
  .step p { margin: 0 0 12px; color: var(--muted); }
  textarea { width: 100%; height: 190px; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--ink); background: var(--paper); border: 1px solid var(--line); border-radius: 10px; padding: 12px; resize: vertical; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 12px; }
  button { font: inherit; font-weight: 600; border: 0; border-radius: 999px; padding: 12px 22px; cursor: pointer; background: var(--accent); color: #fff; }
  button.quiet { background: transparent; color: var(--ink); border: 1px solid var(--line); font-weight: 500; }
  code { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--paper); border: 1px solid var(--line); border-radius: 6px; padding: 1px 6px; word-break: break-all; }
  details { margin-top: 12px; color: var(--muted); }
  details li { margin: 6px 0; }
  .fine { font-size: 14px; color: var(--muted); }
`;

const page = (title: string, body: string) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );

// JSON inside <script>: keep "</script>" from closing the tag early.
const inScript = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

export function landingPage(origin: string): Response {
  return page(
    "EventHog",
    `<h1>EventHog</h1>
<p class="lede">Your AI agent's notebook for a conference. Who to find before, what you learned during, who to follow up with after.</p>

<div class="phases">
  <div class="phase"><b>Before</b>Pulls the attendee list, researches the people, and tells you who's worth finding.</div>
  <div class="phase"><b>During</b>Tell it who you met in a sentence or a badge photo. It keeps the list.</div>
  <div class="phase"><b>After</b>Ranks your follow-ups, drafts the emails, and hands contacts to your CRM.</div>
</div>

<div class="step">
  <h2>1. Copy this prompt</h2>
  <p>It has your own private link in it. Paste it into Claude, ChatGPT, Cursor, Claude Code or Codex, and your agent will connect itself (or walk you through the two clicks).</p>
  <textarea id="prompt" readonly></textarea>
  <div class="row">
    <button id="copy">Copy this prompt</button>
    <button class="quiet" id="copylink">Copy just my link</button>
  </div>
  <details>
    <summary>Set it up by hand instead</summary>
    <p>Your link: <code id="link"></code></p>
    <ul>
      <li><b>Claude</b> (web, desktop, mobile): Settings, Connectors, Add custom connector. Name it EventHog and paste your link.</li>
      <li><b>Cursor</b>: add <code>"event-hog": { "url": "your link" }</code> under <code>mcpServers</code> in <code>~/.cursor/mcp.json</code>.</li>
      <li><b>Claude Code</b>: <code>claude mcp add --transport http event-hog your-link</code></li>
      <li><b>Codex</b>: in <code>~/.codex/config.toml</code>, add <code>[mcp_servers.event-hog]</code> with <code>url = "your link"</code>.</li>
    </ul>
  </details>
</div>

<div class="step">
  <h2>2. Answer two questions</h2>
  <p>Your agent will ask which company you represent and which conference you're going to. Then it picks up wherever you are: before, during, or after.</p>
</div>

<p class="fine">Your link is like a password: anyone with it can write as you. This browser remembers it, so come back here to copy it again. Everything logged here goes into one shared workspace that everyone on this EventHog can see. EventHog never posts or emails anything, and never writes to your CRM by itself.</p>
<p class="fine"><button class="quiet" id="fresh">Make me a new link</button></p>

<script>
  const ORIGIN = ${inScript(origin)};
  const TEMPLATE = ${inScript(connectPrompt())};
  const PLACEHOLDER = ${inScript(KEY_PLACEHOLDER)};
  const STORE = "eventhog-key";
  function newKey() {
    const b = new Uint8Array(24);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  }
  function key() {
    let k = null;
    try { k = localStorage.getItem(STORE); } catch (e) {}
    if (!k || !/^[a-f0-9]{48}$/.test(k)) {
      k = newKey();
      try { localStorage.setItem(STORE, k); } catch (e) {}
    }
    return k;
  }
  function render() {
    const url = ORIGIN + "/mcp/" + key();
    document.getElementById("prompt").value = TEMPLATE.split(PLACEHOLDER).join(url);
    document.getElementById("link").textContent = url;
    return url;
  }
  async function copy(text, btn) {
    try { await navigator.clipboard.writeText(text); }
    catch (e) { const t = document.getElementById("prompt"); t.focus(); t.select(); document.execCommand("copy"); }
    const was = btn.textContent;
    btn.textContent = "Copied. Now paste it into your agent.";
    setTimeout(() => { btn.textContent = was; }, 2500);
  }
  let url = render();
  document.getElementById("copy").onclick = (e) => copy(document.getElementById("prompt").value, e.target);
  document.getElementById("copylink").onclick = (e) => copy(url, e.target);
  document.getElementById("fresh").onclick = () => {
    if (!confirm("Make a new link? Your agent keeps working with the old one; the new one starts as a new person.")) return;
    try { localStorage.removeItem(STORE); } catch (e) {}
    url = render();
  };
</script>`,
  );
}

export function connectorPage(link: string, home: string): Response {
  return page(
    "EventHog connector",
    `<h1>This is an EventHog connector link</h1>
<p class="lede">It isn't a web page. It's the address your AI agent uses to reach EventHog, and it's private to you.</p>
<div class="step">
  <p>Paste it into your agent as a custom connector or MCP server, or go to the <a href="${home.replace(/[<>&"]/g, "")}">EventHog home page</a> and copy the setup prompt, which does it for you.</p>
  <p><code>${link.replace(/[<>&"]/g, "")}</code></p>
</div>`,
  );
}
