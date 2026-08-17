// Headless behaviour check for content.js.
//
// `location.reload` is [Unforgeable] in browsers, so it cannot be stubbed.
// Instead the page is served over HTTP and reloads are counted server-side:
// every extra GET of "/" is a refresh the extension triggered.
import { chromium } from "playwright";
import http from "http";
import fs from "fs";

const src = fs.readFileSync(new URL("../content.js", import.meta.url), "utf8");

const PAGE = `<!doctype html><meta charset=utf-8><title>pull test</title>
<style>body{height:5000px;margin:0;font:14px system-ui}</style>
<h1>pull-to-refresh test page</h1>`;

let hits = 0;
const server = http.createServer((req, res) => {
  if (req.url === "/") hits++;
  res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
  res.end(PAGE);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage();

// Stub the extension storage API, then run the real content script — both on
// every navigation, exactly like a content script with run_at document_start.
await page.addInitScript(`
  window.browser = {
    storage: {
      sync:  { get: (d) => Promise.resolve(d) },
      local: { get: (d) => Promise.resolve(d) },
      onChanged: { addListener() {} }
    }
  };
`);
await page.addInitScript(src);

await page.goto(origin, { waitUntil: "load" });
await page.waitForTimeout(150); // settings promise resolves

const results = [];
let baseline = hits;
function begin() {
  baseline = hits;
}
function reloadsSince() {
  return hits - baseline;
}
function check(name, got, want) {
  results.push({ name, got, want, pass: got === want });
}
const pause = (ms) => page.waitForTimeout(ms);

// Dispatch a wheel "gesture": events spaced closer than GESTURE_GAP_MS (160ms).
async function wheelOn(selector, deltas, stepMs = 20) {
  await page.evaluate(
    async ([sel, ds, ms]) => {
      const target = sel ? document.querySelector(sel) : window;
      for (const d of ds) {
        target.dispatchEvent(
          new WheelEvent("wheel", { deltaY: d, deltaMode: 0, bubbles: true, cancelable: true })
        );
        await new Promise((r) => setTimeout(r, ms));
      }
    },
    [selector, deltas, stepMs]
  );
}
const wheel = (deltas, stepMs) => wheelOn(null, deltas, stepMs);

async function freshPage() {
  await page.goto(origin, { waitUntil: "load" });
  await pause(150);
}

// 1 — deliberate pull at the top, past the 150px threshold
begin();
await wheel(Array(8).fill(-30));
await pause(400);
check("deliberate pull at top reloads", reloadsSince(), 1);

// 2 — fling upward from mid-page: the gesture starts while scrolled down and
//     the momentum tail keeps firing after hitting the top. Must NOT reload.
await freshPage();
await page.evaluate(() => window.scrollTo(0, 1200));
await pause(80);
begin();
await wheel([-400, -350, -300, -250, -200, -150, -100, -80, -60, -40, -30, -20, -10], 16);
await pause(500);
check("momentum after a fling does not reload", reloadsSince(), 0);

// 3 — pull that stops short of the threshold
await freshPage();
begin();
await wheel([-20, -20, -20]);
await pause(500);
check("sub-threshold pull does not reload", reloadsSince(), 0);

// 4 — scrolling down at the top
begin();
await wheel([80, 80, 80]);
await pause(400);
check("downward scroll does not reload", reloadsSince(), 0);

// 5 — pull inside a nested scroll container that is not at its own top
await freshPage();
await page.evaluate(() => {
  const box = document.createElement("div");
  box.id = "box";
  box.style.cssText = "height:200px;overflow-y:auto;border:1px solid #ccc";
  box.innerHTML = "<div style='height:2000px'>inner</div>";
  document.body.prepend(box);
  box.scrollTop = 500;
});
await pause(80);
begin();
await wheelOn("#box", Array(8).fill(-30));
await pause(500);
check("pull inside a scrolled container does not reload", reloadsSince(), 0);

// 6 — same container, now at its own top: the pull belongs to the page again
await page.evaluate(() => {
  document.getElementById("box").scrollTop = 0;
  window.scrollTo(0, 0);
});
await pause(300);
begin();
await wheelOn("#box", Array(8).fill(-30));
await pause(500);
check("container at its top hands the pull to the page", reloadsSince(), 1);

// 7 — indicator mounts, and only once
await freshPage();
await wheel([-20, -20]);
await pause(120);
const indicators = await page.evaluate(
  () => document.querySelectorAll("[data-pull-to-refresh]").length
);
check("indicator mounted exactly once", indicators, 1);

// 8 — indicator does not leak styles into the page (shadow DOM is closed)
const leaked = await page.evaluate(() => {
  const host = document.querySelector("[data-pull-to-refresh]");
  return host ? host.shadowRoot : "no-host";
});
check("indicator shadow root is closed", leaked, null);

// 9 — two separated sub-threshold pulls do not add up into a refresh
await freshPage();
begin();
await wheel([-30, -30]);
await pause(600);
await wheel([-30, -30]);
await pause(600);
check("separate short pulls do not accumulate", reloadsSince(), 0);

await browser.close();
server.close();

let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(
    `${r.pass ? "PASS" : "FAIL"}  ${r.name}` + (r.pass ? "" : `  (got ${r.got}, want ${r.want})`)
  );
}
console.log(failed ? `\n${failed} of ${results.length} failing` : `\nall ${results.length} passing`);
process.exit(failed ? 1 : 0);
