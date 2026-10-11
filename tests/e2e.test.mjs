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
async function open(url, { blockCdn = false } = {}) {
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
  await page.navigate(url);
  page.go = async (hash) => { await page.evaluate(`location.hash = ${JSON.stringify(hash)}`); await page.evaluate("new Promise(r => setTimeout(r, 50))"); };
  page.text = (sel) => page.evaluate(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? null`);
  page.count = (sel) => page.evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  return page;
}

async function test(name, fn) {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.stack.split("\n").slice(0, 3).join("\n     ")}`); }
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

await test("invalid config is refused by build.py", async () => {
  assert.throws(() => build("bad", example, { notes: { "no-such-section": "x" } }), /unknown section id/);
});

chrome.close();
console.log(failures ? `\n${failures} failed` : "\nall e2e tests passed");
process.exit(failures ? 1 : 0);
