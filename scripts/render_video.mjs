// Frame capture: opens render/player.html in headless Chrome and writes one JPEG per frame to stdout.
// No npm packages: Chrome is driven over the DevTools protocol (cdp.mjs, Node 22+ built-in WebSocket).
// usage: node render_video.mjs <chrome> <page.html> <fps> <frames> <width> <height>
import { pathToFileURL } from "node:url";
import { launchChrome } from "./cdp.mjs";

const [chromePath, file, fps, frames, width, height] = process.argv.slice(2);
const chrome = await launchChrome(chromePath);
const page = await chrome.newPage(+width, +height);
await page.navigate(pathToFileURL(file).href);
await page.evaluate("document.fonts.ready.then(() => true)");

if (!(await page.evaluate("typeof window.seek === 'function'"))) throw new Error("player.js did not load (window.seek is missing)");

const total = +frames;
for (let i = 0; i < total; i++) {
  await page.cdp("Runtime.evaluate", { expression: `seek(${i / +fps})` });
  const { data } = await page.cdp("Page.captureScreenshot", { format: "jpeg", quality: 92, optimizeForSpeed: true });
  if (!process.stdout.write(Buffer.from(data, "base64"))) await new Promise((r) => process.stdout.once("drain", r));
  if (i % 150 === 0) process.stderr.write(`frame ${i}/${total}\n`);
}
// Exit explicitly: Chrome would keep Node alive, and ffmpeg only stops when this process closes stdout.
process.stdout.end(() => process.exit(0));
