// Minimal Chrome DevTools Protocol client: headless Chrome + Node's built-in WebSocket (Node 22+).
// No npm packages. Used by render_video.mjs (video frames) and tests/e2e.test.mjs (browser tests).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function launchChrome(chromePath) {
  const profile = mkdtempSync(join(tmpdir(), "too-long-chrome-"));
  const chrome = spawn(chromePath, [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--hide-scrollbars",
    "--allow-file-access-from-files", "--no-first-run", "--disable-gpu", "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const close = () => { chrome.kill(); try { rmSync(profile, { recursive: true, force: true }); } catch {} };
  process.on("exit", close);

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
  const listeners = new Set();
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

  // A page (tab). cdp() sends to it; on() receives its events.
  async function newPage(width = 1280, height = 800) {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const cdp = (method, params) => send(method, params, sessionId);
    const on = (fn) => { const l = (m) => m.sessionId === sessionId && fn(m); listeners.add(l); return () => listeners.delete(l); };
    await cdp("Page.enable");
    await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    const load = async (method, params) => {
      const loaded = new Promise((ok) => { const off = on((m) => { if (m.method === "Page.loadEventFired") { off(); ok(); } }); });
      await cdp(method, params);
      await loaded;
    };
    // A URL that differs only in its #hash does not load a new page: use reload() for that.
    const navigate = (url) => load("Page.navigate", { url });
    const reload = () => load("Page.reload", {});
    // Evaluate an expression in the page and return its (JSON) value; awaits promises.
    const evaluate = async (expression) => {
      const r = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(`in page: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
      return r.result.value;
    };
    return { cdp, on, navigate, reload, evaluate };
  }

  return { newPage, close };
}
