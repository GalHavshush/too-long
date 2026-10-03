// Frame capture: opens render/player.html in headless Chrome and writes one JPEG per frame to stdout.
// No npm packages: Chrome is driven over the DevTools protocol with Node's built-in WebSocket (Node 22+).
// usage: node render_video.mjs <chrome> <page.html> <fps> <frames> <width> <height>
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [chromePath, page, fps, frames, width, height] = process.argv.slice(2);
const profile = mkdtempSync(join(tmpdir(), "too-long-chrome-"));
const chrome = spawn(chromePath, [
  "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--hide-scrollbars",
  "--allow-file-access-from-files", "--no-first-run", "--disable-gpu", "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });

const cleanup = () => { chrome.kill(); try { rmSync(profile, { recursive: true, force: true }); } catch {} };
process.on("exit", cleanup);

// Chrome prints "DevTools listening on ws://..." on stderr.
const endpoint = await new Promise((resolve, reject) => {
  let buf = "";
  chrome.stderr.on("data", (d) => {
    buf += d;
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) resolve(m[1]);
  });
  chrome.on("exit", () => reject(new Error("Chrome exited before it was ready")));
  setTimeout(() => reject(new Error("Chrome did not start within 20s")), 20000);
});

const ws = new WebSocket(endpoint);
await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = () => fail(new Error("DevTools connection failed")); });

let nextId = 0;
const pending = new Map();
const listeners = [];
ws.onmessage = ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.id && pending.has(msg.id)) {
    const { ok, fail } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? fail(new Error(msg.error.message)) : ok(msg.result);
  } else listeners.forEach((fn) => fn(msg));
};
const send = (method, params = {}, sessionId) =>
  new Promise((ok, fail) => {
    const id = ++nextId;
    pending.set(id, { ok, fail });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
const cdp = (method, params) => send(method, params, sessionId);

await cdp("Page.enable");
await cdp("Emulation.setDeviceMetricsOverride", { width: +width, height: +height, deviceScaleFactor: 1, mobile: false });
const loaded = new Promise((ok) => listeners.push((m) => m.method === "Page.loadEventFired" && ok()));
await cdp("Page.navigate", { url: pathToFileURL(page).href });
await loaded;
await cdp("Runtime.evaluate", { expression: "document.fonts.ready.then(() => true)", awaitPromise: true });

const ready = await cdp("Runtime.evaluate", { expression: "typeof window.seek === 'function'", returnByValue: true });
if (!ready.result.value) throw new Error("player.js did not load (window.seek is missing)");

const total = +frames;
for (let i = 0; i < total; i++) {
  await cdp("Runtime.evaluate", { expression: `seek(${i / +fps})` });
  const { data } = await cdp("Page.captureScreenshot", { format: "jpeg", quality: 92, optimizeForSpeed: true });
  if (!process.stdout.write(Buffer.from(data, "base64"))) await new Promise((r) => process.stdout.once("drain", r));
  if (i % 150 === 0) process.stderr.write(`frame ${i}/${total}\n`);
}
// Exit explicitly: Chrome would keep Node alive, and ffmpeg only stops when this process closes stdout.
process.stdout.end(() => process.exit(0));
