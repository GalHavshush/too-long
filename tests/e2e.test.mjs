// Browser end-to-end tests for the generated site:  node tests/e2e.test.mjs
// Builds sites with scripts/build.py, opens them over file:// in headless Chrome (scripts/cdp.mjs),
// and checks views, navigation, tasks, persistence, diagram fallback, source links, a11y basics
// and console errors. Needs Node 22+ and Chrome; skips (exit 0) when either is missing.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = join(ROOT, "scripts");
const py = (args, opts = {}) => execFileSync("python3", args, { cwd: SCRIPTS, encoding: "utf8", stdio: "pipe", ...opts });

if (+process.versions.node.split(".")[0] < 22) { console.log("skip: Node 22+ needed"); process.exit(0); }
const chromePath = py(["-c", "from video import find_chrome; print(find_chrome() or '')"]).trim();
if (!chromePath) { console.log("skip: Chrome not found"); process.exit(0); }
const { launchChrome } = await import(pathToFileURL(join(SCRIPTS, "cdp.mjs")).href);

const tmp = mkdtempSync(join(tmpdir(), "too-long-e2e-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));

// Build a site: md file, optional config object -> file:// URL of index.html
function build(name, md, config) {
  const out = join(tmp, name);
  mkdirSync(out, { recursive: true });
  if (config) writeFileSync(join(out, "config.json"), JSON.stringify(config));
  py(["build.py", md, "--out", out]);
  return pathToFileURL(join(out, "index.html")).href;
}

const chrome = await launchChrome(chromePath);
setTimeout(() => { console.log("FAIL e2e tests timed out after 90s"); process.exit(1); }, 90000).unref();
let failures = 0;

// Open a page that records console errors and uncaught exceptions.
async function open(url, { blockCdn = false, init } = {}) {
  const page = await chrome.newPage(1280, 900);
  page.errors = [];
  page.on((m) => {
    if (m.method === "Runtime.exceptionThrown") page.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") page.errors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error" && m.params.entry.source !== "network") page.errors.push(m.params.entry.text);
  });
  await page.cdp("Runtime.enable");
  await page.cdp("Log.enable");
  if (blockCdn) {
    await page.cdp("Network.enable");
    await page.cdp("Network.setBlockedURLs", { urls: ["*cdn.jsdelivr.net*"] });
  }
  if (init) await page.cdp("Page.addScriptToEvaluateOnNewDocument", { source: init });
  await page.navigate(url);
  page.go = async (hash) => { await page.evaluate(`location.hash = ${JSON.stringify(hash)}`); await page.evaluate("new Promise(r => setTimeout(r, 50))"); };
  page.text = (sel) => page.evaluate(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? null`);
  page.count = (sel) => page.evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  return page;
}

async function test(name, fn) {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.stack.split("\n").slice(0, 12).join("\n     ")}`); }
}

const example = join(ROOT, "examples", "trailhead-plan.md");
const exampleConfig = JSON.parse(execFileSync("cat", [join(ROOT, "examples", "trailhead-site", "config.json")], { encoding: "utf8" }));
const site = build("example", example, exampleConfig);

await test("every view renders without errors", async () => {
  const p = await open(site, { blockCdn: true });
  const views = await p.evaluate(`[...document.querySelectorAll("#views a")].map(a => a.dataset.view)`);
  assert.deepEqual(views, exampleConfig.views.includes("document") ? exampleConfig.views : [...exampleConfig.views, "document"]);
  for (const v of views) {
    await p.go(`#/${v}`);
    const text = await p.text("#view");
    assert.ok(text && text.length > 40, `view ${v} is empty`);
    assert.ok(!/undefined|\[object Object\]|NaN/.test(text), `view ${v} shows a broken value`);
    assert.equal(await p.evaluate(`document.querySelector("#views a.active")?.dataset.view`), v);
  }
  assert.deepEqual(p.errors, []);
});

await test("document sections collapse and expand", async () => {
  const p = await open(site + "#/document");
  const total = await p.count("details.sec");
  assert.ok(total > 3);
  await p.evaluate(`document.querySelector('[data-act="collapse"]').click()`);
  assert.equal(await p.count("details.sec[open]"), 0);
  await p.evaluate(`document.querySelector('[data-act="expand"]').click()`);
  assert.equal(await p.count("details.sec[open]"), total);
  await p.evaluate(`document.querySelector('[data-act="raw"]').click()`);
  assert.equal(await p.evaluate(`document.querySelector(".raw").hidden`), false);
});

await test("checking a task persists across reload and updates progress", async () => {
  const p = await open(site + "#/tasks/open");
  const before = await p.text('[data-badge="tasks"]');
  const id = await p.evaluate(`(() => { const b = document.querySelector("input[data-task]:not(:checked)"); b.click(); return b.dataset.task; })()`);
  const after = await p.text('[data-badge="tasks"]');
  assert.equal(+after.split("/")[0], +before.split("/")[0] + 1);
  await p.go("#/tasks");
  await p.reload();
  assert.equal(await p.evaluate(`document.querySelector('input[data-task="${id}"]').checked`), true);
  // Reset goes back to the Markdown's state.
  await p.evaluate(`window.confirm = () => true; document.querySelector('[data-act="reset"]').click()`);
  assert.equal(await p.evaluate(`document.querySelector('input[data-task="${id}"]').checked`), false);
  assert.deepEqual(p.errors, []);
});

await test("source links open the cited line", async () => {
  const p = await open(site + "#/highlights");
  const href = await p.evaluate(`document.querySelector("a.where").getAttribute("href")`);
  const line = +href.split("/").pop();
  await p.evaluate(`document.querySelector("a.where").click()`);
  await p.evaluate("new Promise(r => setTimeout(r, 50))");
  assert.equal(await p.evaluate("location.hash"), href);
  const hit = await p.evaluate(`(() => { const el = document.querySelector("#L${line}.hit"); const r = el.getBoundingClientRect(); return { top: r.top, h: innerHeight }; })()`);
  assert.ok(hit.top >= 0 && hit.top < hit.h, `highlighted line is off screen: ${JSON.stringify(hit)}`);
  const src = execFileSync("sed", ["-n", `${line}p`, example], { encoding: "utf8" }).replace(/\n$/, "");
  assert.equal(await p.text(`#L${line}`), src || " ");
});

await test("diagrams fall back to their source when Mermaid cannot load", async () => {
  const p = await open(site + "#/diagrams", { blockCdn: true });
  await p.evaluate("new Promise(r => setTimeout(r, 500))");
  const n = await p.count("figure.diagram");
  assert.ok(n >= 1);
  assert.equal(await p.count("figure.diagram.offline"), n);
  assert.match(await p.text("figure.diagram pre"), /^(sequenceDiagram|flowchart|graph)/);
  assert.deepEqual(p.errors, []);
});

await test("basic accessibility", async () => {
  const p = await open(site + "#/tasks");
  const a11y = await p.evaluate(`({
    lang: document.documentElement.lang,
    title: document.title,
    unlabelledBoxes: [...document.querySelectorAll("input[type=checkbox]")].filter(b => !b.getAttribute("aria-label") && !b.labels.length).length,
    unnamedButtons: [...document.querySelectorAll("button")].filter(b => !b.textContent.trim() && !b.getAttribute("aria-label")).length,
    navs: [...document.querySelectorAll("nav")].every(n => n.getAttribute("aria-label")),
    main: !!document.querySelector("main"),
    search: !!document.querySelector("#search").labels.length,
  })`);
  assert.equal(a11y.lang, "en");
  assert.ok(a11y.title.length > 0);
  assert.equal(a11y.unlabelledBoxes, 0);
  assert.equal(a11y.unnamedButtons, 0);
  assert.ok(a11y.navs && a11y.main && a11y.search);
  await p.go("#/document");
  assert.equal(await p.evaluate(`[...document.querySelectorAll("img")].filter(i => !i.hasAttribute("alt")).length`), 0);
});

await test("no config: suggested views, still works", async () => {
  const url = build("noconfig", join(ROOT, "tests", "fixtures", "nested.md"));
  const p = await open(url);
  const views = await p.evaluate(`[...document.querySelectorAll("#views a")].map(a => a.dataset.view)`);
  assert.ok(views.includes("overview") && views.includes("document") && views.includes("tasks"));
  await p.go("#/tasks");
  assert.equal(await p.count("input[data-task]"), 3);
  await p.go("#/nonexistent-view");
  assert.equal(await p.evaluate(`document.querySelector("#views a.active")?.dataset.view`), views[0]);
  assert.deepEqual(p.errors, []);
});

await test("partial config: only the views asked for (plus document)", async () => {
  const url = build("partial", join(ROOT, "tests", "fixtures", "headings.md"), { views: ["tasks"] });
  const p = await open(url);
  assert.deepEqual(await p.evaluate(`[...document.querySelectorAll("#views a")].map(a => a.dataset.view)`), ["tasks", "document"]);
  assert.ok((await p.text("#view")).includes("Install dependencies"));
  assert.deepEqual(p.errors, []);
});

await test("empty document renders", async () => {
  const p = await open(build("empty", join(ROOT, "tests", "fixtures", "empty.md")));
  for (const v of ["overview", "document"]) { await p.go(`#/${v}`); assert.ok(await p.text("#view") !== null); }
  assert.deepEqual(p.errors, []);
});

await test("same-titled documents keep separate task state", async () => {
  const md = (name, extra) => { const f = join(tmp, name); writeFileSync(f, `# Same title\n\n## Work\n\n- [ ] Shared task\n${extra}`); return f; };
  const a = build("same-a", md("a.md", ""));
  const b = build("same-b", md("b.md", "- [ ] Only in b\n"));
  const p = await open(a + "#/tasks");
  await p.evaluate(`document.querySelector("input[data-task]").click()`);
  await p.navigate(b + "#/tasks");
  assert.equal(await p.evaluate(`document.querySelector("input[data-task]").checked`), false);
  await p.navigate(a + "#/tasks");
  assert.equal(await p.evaluate(`document.querySelector("input[data-task]").checked`), true);
});

await test("state saved under the old title key is migrated once", async () => {
  const f = join(tmp, "legacy.md");
  writeFileSync(f, "# Legacy plan\n\n## Work\n\n- [ ] Old task\n");
  const url = build("legacy", f);
  const p = await open(url);
  const id = await p.evaluate(`document.querySelector("input[data-task]")?.dataset.task || window.TOO_LONG.model.tasks[0].id`);
  await p.evaluate(`localStorage.setItem("too-long:Legacy plan:tasks", JSON.stringify({ "${id}": true }))`);
  await p.evaluate(`Object.keys(localStorage).filter(k => k.endsWith(":migrated")).forEach(k => localStorage.removeItem(k))`);
  await p.go("#/tasks");
  await p.reload();
  assert.equal(await p.evaluate(`document.querySelector('input[data-task="${id}"]').checked`), true);
});

await test("a saved check does not apply once the task text changed", async () => {
  const f = join(tmp, "sig.md");
  writeFileSync(f, "# Sig plan\n\n## Work\n\n- [ ] Task\n");
  const url = build("sig", f);
  const p = await open(url + "#/tasks");
  const key = await p.evaluate(`"too-long:" + window.TOO_LONG.model.doc_id + ":tasks"`);
  const id = await p.evaluate(`window.TOO_LONG.model.tasks[0].id`);
  await p.evaluate(`localStorage.setItem(${JSON.stringify(key)}, JSON.stringify({ "${id}": { done: true, sig: "stale" } }))`);
  await p.reload();
  assert.equal(await p.evaluate(`document.querySelector('input[data-task="${id}"]').checked`), false);
});

await test("hostile Markdown and config cannot run script or inject attributes", async () => {
  const cfg = JSON.parse(execFileSync("cat", [join(ROOT, "tests", "security", "xss-config.json")], { encoding: "utf8" }));
  const url = build("xss", join(ROOT, "tests", "security", "xss.md"), cfg);
  const p = await open(url, { init: "window.alert = window.confirm = window.prompt = () => { window.__pwned = 1; };" });
  const check = () => p.evaluate(`(() => {
    const all = [...document.querySelectorAll("*")];
    return {
      pwned: !!window.__pwned,
      handlers: all.flatMap(el => [...el.attributes].filter(a => /^on/i.test(a.name)).map(a => el.tagName + " " + a.name)),
      scripts: document.querySelectorAll("body script:not([src='data.js']):not([src='app.js']), iframe, object, embed").length,
      badLinks: [...document.querySelectorAll("a[href]")].map(a => a.href).filter(h => !/^(https?:|mailto:|file:)/.test(h)),
      badImages: [...document.querySelectorAll("img[src]")].map(i => i.getAttribute("src")).filter(s => !/^(https?:|file:|#$|data:image[/]png;)/.test(s) && /:/.test(s)),
    };
  })()`);
  for (const v of cfg.views.concat(["source/3", "files/src/ok.ts"])) {
    await p.go(`#/${v}`);
    await p.evaluate("new Promise(r => setTimeout(r, 30))");
    const r = await check();
    assert.deepEqual(r, { pwned: false, handlers: [], scripts: 0, badLinks: [], badImages: [] }, `view ${v}`);
  }
  assert.deepEqual(p.errors, []);
  // Legitimate Markdown still works.
  await p.go("#/document");
  const ok = await p.evaluate(`({
    ok: !!document.querySelector('a[href="https://example.com/ok"][target="_blank"]'),
    ref: !!document.querySelector('a[href="https://example.com/good"]'),
    emphasisUrl: !!document.querySelector('a[href="https://example.com/*a*/_b_/~~c~~"]'),
    boldLink: !!document.querySelector('strong > a[href="https://example.com/__x__"]'),
    anchor: !!document.querySelector('a[href="#links"]'),
    png: !!document.querySelector('img[src^="data:image/png;"]'),
    blocked: [...document.querySelectorAll("a")].filter(a => a.getAttribute("href") === "#").map(a => a.textContent).sort(),
    rawHtmlShownAsText: document.querySelector("#intro").textContent.includes("<script>"),
  })`);
  assert.deepEqual(ok, { ok: true, ref: true, emphasisUrl: true, boldLink: true, anchor: true, png: true, rawHtmlShownAsText: true,
    blocked: ["control char", "data", "js", "mixed case", "ref link", "vbscript"] });
});

await test("inferred content is flagged when its source changes", async () => {
  const f = join(tmp, "stale.md");
  writeFileSync(f, "# Stale\n\n## Alpha\n\nA.\n\n## Beta\n\nB.\n");
  const cfg = { views: ["overview", "diagrams"], tldr: ["Short."], notes: { alpha: "About alpha." },
    diagrams: [{ title: "D", mermaid: "flowchart TD\n A-->B", sources: ["beta"] }] };
  const url = build("stale", f, cfg);
  const p = await open(url + "#/overview", { blockCdn: true });
  assert.equal(await p.count(".badge.stale"), 0);
  writeFileSync(f, "# Stale\n\n## Alpha\n\nA.\n\n## Beta\n\nB, changed.\n");
  build("stale", f);  // same output folder, config unchanged
  await p.reload();
  assert.equal(await p.count(".badge.stale"), 1);  // the TL;DR
  await p.go("#/diagrams");
  assert.equal(await p.count(".diagram-card .badge.stale"), 1);
  await p.go("#/document");
  assert.equal(await p.count(".badge.stale"), 0);  // the note on Alpha is still current
});

await test("invalid config is refused by build.py", async () => {
  assert.throws(() => build("bad", example, { notes: { "no-such-section": "x" } }), /unknown section id/);
});

chrome.close();
console.log(failures ? `\n${failures} failed` : "\nall e2e tests passed");
process.exit(failures ? 1 : 0);
