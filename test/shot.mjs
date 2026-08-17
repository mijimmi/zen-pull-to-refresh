import { chromium } from "playwright";
import fs from "fs";
const src = fs.readFileSync("/root/pull-to-refresh/content.js","utf8");
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const body = (scheme) => encodeURIComponent(`<style>body{height:3000px;margin:0;font:15px system-ui;padding:56px 24px;background:${scheme==='dark'?'#141417':'#fff'};color:${scheme==='dark'?'#e6e6ea':'#16161a'}}</style><h2>Pull to refresh — ${scheme} mode</h2><p>The puck drops in from the top and its arc fills as you keep pulling.</p>`);
for (const scheme of ["light","dark"]) {
  const page = await b.newPage({ colorScheme: scheme, viewport:{width:720,height:260}, deviceScaleFactor:2 });
  await page.addInitScript(`window.browser={storage:{sync:{get:d=>Promise.resolve(d)},local:{get:d=>Promise.resolve(d)},onChanged:{addListener(){}}}};`);
  await page.addInitScript(src);
  await page.goto("data:text/html," + body(scheme));
  await page.waitForTimeout(200);
  await page.evaluate(async () => { for (let i=0;i<3;i++){ window.dispatchEvent(new WheelEvent("wheel",{deltaY:-35,bubbles:true})); await new Promise(r=>setTimeout(r,25)); } });
  await page.waitForTimeout(80);
  await page.screenshot({ path: `/root/pull-to-refresh/test/indicator-${scheme}.png` });
  await page.close();
}
await b.close();
console.log("ok");
