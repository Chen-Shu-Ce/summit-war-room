/**
 * e2e.mjs — 用 Chromium 實際開頁面，驗證三欄互動、DXF 自動抓量、PDF 校正量測、採購包與匯出。
 * 執行： node tests/e2e.mjs   （需要本機已安裝 playwright 與 Chromium）
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../public', import.meta.url)));
const FIX = resolve(fileURLToPath(new URL('.', import.meta.url)));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm', '.pdf': 'application/pdf' };

const server = createServer(async (req, res) => {
  try {
    const p = join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    if (!p.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const s = await stat(p).catch(() => null);
    if (!s || !s.isFile()) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(await readFile(p));
  } catch (e) { res.writeHead(500).end(String(e)); }
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? (pass++, console.log('  ok  ', name)) : (fail++, console.log('  FAIL', name, extra)); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(base + '/takeoff.html');
await page.waitForFunction(() => window.__takeoff && window.__takeoff.state.items.length > 0);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForFunction(() => window.__takeoff && window.__takeoff.state.items.length > 0);

console.log('\n【1】版面與初始資料');
ok('WBS 樹有節點', await page.locator('#tree .node').count() > 5);
ok('BOM 表格有列', await page.locator('#boqBody tr[data-code]').count() > 10);
const cable = page.locator('tr[data-code="26.05.19.010"]');
ok('附件一工項存在', await cable.count() === 1);
const sug = (await cable.locator('td.sug').innerText()).trim();
ok('建議採購量 = 1,751 M', sug.startsWith('1,751'), sug);
const varChip = (await cable.locator('td').nth(5).innerText()).trim();
ok('差異顯示 +60 / 3.6%', varChip.includes('60') && varChip.includes('3.6'), varChip);
const band = (await cable.locator('[data-conf]').innerText()).trim();
ok('可信度顯示等級與分數', /^A \d+/.test(band), band);

console.log('\n【2】WBS 父子連動多選');
await page.locator('#tree input[data-node="26"]').check();
const selAfter = await page.evaluate(() => window.__takeoff.state.selected.size);
ok('勾選父節點會帶入所有子孫工項', selAfter === 8, '選到 ' + selAfter);
const indet = await page.evaluate(() => {
  const cb = document.querySelector('#tree input[data-node="26.05"]');
  return cb ? cb.checked : null;
});
ok('子節點同步為勾選', indet === true);
await page.locator('tr[data-code="26.05.19.010"] input[data-pick]').uncheck();
const half = await page.evaluate(() => document.querySelector('#tree input[data-node="26"]').indeterminate);
ok('取消單項後父節點呈半選', half === true);
await page.locator('tr[data-code="26.05.19.010"] input[data-pick]').check();

console.log('\n【3】差異超標會鎖定並擋下轉採購');
const cat6 = page.locator('tr[data-code="27.15.010"]');
ok('Cat.6A 差異 11.9% 被鎖定', (await cat6.innerText()).includes('鎖定'));
ok('鎖定項目無建議採購量', (await cat6.locator('td.sug').innerText()).trim() === '—');

console.log('\n【4】人工確認流程');
await page.locator('tr[data-code="27.15.010"] [data-src]').click();
await page.waitForSelector('#dlg[open]');
await page.fill('#dlgBody input[data-q="manual"]', '5600');
await page.fill('#mBy', '電氣工程師');
await page.fill('#mNote', '現場複核含機櫃內佈線');
await page.locator('#dlgFoot button.primary').click();
await page.waitForSelector('#dlg[open]', { state: 'hidden' });
const cat6b = (await page.locator('tr[data-code="27.15.010"]').innerText());
ok('人工確認後解除鎖定', !cat6b.includes('鎖定'), cat6b.replace(/\s+/g, ' ').slice(0, 120));
const sug2 = (await page.locator('tr[data-code="27.15.010"] td.sug').innerText()).trim();
ok('5600 × 1.08 = 6,048 M', sug2.startsWith('6,048'), sug2);
const order2 = (await page.locator('tr[data-code="27.15.010"] td').nth(10).innerText()).trim();
ok('305M/箱 → 20 箱', order2.startsWith('20 箱'), order2);

console.log('\n【5】DXF 載入與圖層自動抓量');
await page.locator('#tabView').click();
await page.setInputFiles('#fileDrawing', join(FIX, 'fixture.dxf'));
await page.waitForFunction(() => window.__takeoff.state.viewer.mode === 'dxf');
ok('DXF 已載入且解析出實體', await page.evaluate(() => window.__takeoff.state.viewer.flat.length) > 5);
ok('讀到公厘單位', await page.evaluate(() => window.__takeoff.state.viewer.metersPerUnit) === 0.001);
await page.waitForSelector('#dlg[open]');
ok('自動開啟圖層對映', (await page.locator('#dlgTitle').innerText()).includes('圖層'));
const mapped = await page.evaluate(() => {
  const sels = [...document.querySelectorAll('#dlgBody [data-map]')];
  return sels.map((s) => [s.parentElement.querySelector('.lname').textContent, s.value]);
});
ok('E-CABLE-PWR 自動猜到電纜工項', mapped.some(([l, v]) => l === 'E-CABLE-PWR' && v.startsWith('26.05.19')), JSON.stringify(mapped));
ok('E-LITE 自動猜到照明工項', mapped.some(([l, v]) => l === 'E-LITE' && v.startsWith('26.51')), JSON.stringify(mapped));
await page.locator('#dlgFoot button.primary').click();
await page.waitForTimeout(200);
const drawQty = await page.evaluate(() => {
  const s = window.__takeoff.state;
  const cable = s.itemByCode.get('26.05.19.010');
  const lite = s.itemByCode.get('26.51.010');
  return { cable: cable.qty.drawing, cableSrc: cable.drawingSource, lite: lite.qty.drawing, prov: cable.provenance };
});
// 電纜圖層 = 5000 + π/2·1000 + π·1000 mm = 9.712m
ok('電纜圖面量由圖層彙總寫入 (9.7124 M)', Math.abs(drawQty.cable - 9.7124) < 0.001, String(drawQty.cable));
ok('燈具計數由圖塊寫入 (4)', drawQty.lite === 4, String(drawQty.lite));
ok('留下數量出處', drawQty.prov && drawQty.prov.kind === 'dxf-layer' && drawQty.prov.layer === 'E-CABLE-PWR', JSON.stringify(drawQty.prov));

console.log('\n【6】PDF 載入、比例校正與量測');
await page.setInputFiles('#fileDrawing', join(FIX, 'fixture.pdf'));
await page.waitForFunction(() => window.__takeoff.state.viewer.mode === 'pdf' && !!window.__takeoff.state.viewer.raster);
await page.waitForSelector('#dlg[open]');
ok('PDF 未校正時警告', (await page.locator('#dlgBody').innerText()).includes('未設定比例'));
await page.locator('#dlgFoot button').last().click();
await page.waitForSelector('#dlg[open]', { state: 'hidden' });
ok('比例晶片顯示未設定', (await page.locator('#scaleChip').innerText()).includes('未設定'));

// 校正：PDF 上 (100,700)-(400,700) 這條線長 300pt，宣告為 30 m
await page.locator('#tools [data-tool="calib"]').click();
await clickWorld(page, 100, 142);   // PDF user space y=700 → viewer world y = 842-700 = 142
await clickWorld(page, 400, 142);
await page.waitForSelector('#dlg[open]');
await page.fill('#calLen', '30');
await page.locator('#dlgFoot button.primary').click();
await page.waitForSelector('#dlg[open]', { state: 'hidden' });
const mpu = await page.evaluate(() => window.__takeoff.state.viewer.metersPerUnit);
ok('兩點校正得 ~0.1 m/pt（像素吸附誤差 <1%）', Math.abs(mpu - 0.1) / 0.1 < 0.01, String(mpu));

// 量第二條線 (100,600)-(250,600) = 150pt → 15 m
await page.locator('#tools [data-tool="length"]').click();
await clickWorld(page, 100, 242);
await clickWorld(page, 250, 242);
await page.keyboard.press('Enter');
await page.waitForTimeout(150);
const mval = await page.evaluate(() => {
  const v = window.__takeoff.state.viewer;
  const m = v.measurements[v.measurements.length - 1];
  return m ? v.engValue(m).value : null;
});
ok('量得 15 M（吸附後誤差 <1%）', mval != null && Math.abs(mval - 15) / 15 < 0.01, String(mval));

// 指派到工項
await page.locator('#mlist [data-assign]').last().click();
await page.waitForSelector('#dlg[open]');
await page.selectOption('#asItem', '22.11.010');
await page.selectOption('#asMode', 'set');
await page.locator('#dlgFoot button.primary').click();
await page.waitForTimeout(150);
const assigned = await page.evaluate(() => {
  const it = window.__takeoff.state.itemByCode.get('22.11.010');
  return { q: it.qty.drawing, src: it.drawingSource, cal: it.calibration, prov: it.provenance && it.provenance.kind };
});
ok('量測值寫入圖面量', Math.abs(assigned.q - 15) / 15 < 0.01, JSON.stringify(assigned));
ok('標記為實測且記錄校正方式', assigned.src === 'measure' && assigned.cal === 'two-point', JSON.stringify(assigned));

console.log('\n【7】採購包與匯出');
await page.locator('#tabList').click();
await page.evaluate(() => {
  const s = window.__takeoff.state;
  s.selected = new Set(['26.05.19.010', '26.05.33.010', '26.24.010']);
});
await page.locator('#btnRmSel').click();      // 觸發重繪
await page.evaluate(() => {
  const s = window.__takeoff.state;
  s.selected = new Set(['26.05.19.010', '26.05.33.010', '26.24.010']);
  document.querySelector('#btnToPkg').click();
});
await page.waitForSelector('#dlg[open]');
ok('轉採購包對話框列出納入項數', (await page.locator('#dlgBody').innerText()).includes('3'));
await page.locator('#dlgFoot button.primary').click();
await page.waitForTimeout(150);
ok('採購包已建立', await page.evaluate(() => window.__takeoff.state.packages.length) === 1);
ok('採購包卡片渲染', await page.locator('.pkg').count() === 1);
const pkgTxt = await page.locator('.pkg').innerText();
ok('採購包顯示金額', /NT\$/.test(pkgTxt), pkgTxt.replace(/\s+/g, ' ').slice(0, 100));

const dl = page.waitForEvent('download');
await page.locator('#btnExport').click();
await page.locator('#eSel').click();
const file = await dl;
const csv = await readFile(await file.path(), 'utf8');
ok('CSV 含表頭與稽核欄', csv.includes('正式採購基準') && csv.includes('判定規則') && csv.includes('數量出處'));
ok('CSV 含 1751 建議採購量', csv.includes('1751'), csv.split('\n')[1] || '');

console.log('\n【7b】合約型態與計價影響');
const payTxt = await page.locator('tr[data-code="23.21.010"] .pay').innerText();
ok('實作實算下標示可計價增量', payTxt.includes('可計價增量'), payTxt);
const payNote = await page.locator('tr[data-code="23.21.010"] .pay').getAttribute('title');
ok('滑鼠提示帶出估驗計量說明', /實作實算/.test(payNote), String(payNote).slice(0, 60));
const payDown = await page.locator('tr[data-code="22.13.010"] .pay').innerText();
ok('實作量低於標單標示計價減量', payDown.includes('計價減量'), payDown);
await page.locator('#btnSettings').click();
await page.waitForSelector('#dlg[open]');
ok('參數頁預設容忍 5%', await page.inputValue('#sWarn') === '0.05', await page.inputValue('#sWarn'));
ok('參數頁預設實作實算', await page.inputValue('#sContract') === 'remeasure');
await page.selectOption('#sContract', 'lumpsum');
await page.locator('#dlgFoot button.primary').click();
await page.waitForTimeout(150);
const payLump = await page.locator('tr[data-code="23.21.010"] .pay').innerText();
ok('切成總價承攬後改標自行吸收風險', payLump.includes('自行吸收'), payLump);
await page.locator('#btnSettings').click();
await page.waitForSelector('#dlg[open]');
await page.selectOption('#sContract', 'remeasure');
await page.locator('#dlgFoot button.primary').click();
await page.waitForTimeout(150);

console.log('\n【7c】自動建議拆包');
await page.evaluate(() => {
  window.__takeoff.state.selected = new Set(['26.05.19.010', '26.05.33.010', '26.24.010', '22.13.010', '23.21.010']);
});
await page.locator('#btnAutoPkg').click();
await page.waitForSelector('#dlg[open]');
const cards = await page.locator('.sugpkg').count();
ok('依前置期分出多個包', cards >= 3, '包數 ' + cards);
const firstCard = await page.locator('.sugpkg').first().innerText();
ok('長前置（120 天配電盤）排最前', firstCard.includes('長前置') && firstCard.includes('配電盤'), firstCard.replace(/\s+/g, ' ').slice(0, 90));
await page.locator('#dlgFoot button.primary').click();
await page.waitForTimeout(200);
if (await page.locator('#dlg[open]').count()) await page.locator('#dlgFoot button').last().click();
const pkgTotal = await page.evaluate(() => window.__takeoff.state.packages.length);
ok('自動包已建立（含先前手動 1 包）', pkgTotal === 1 + cards, '共 ' + pkgTotal);
const autoFlag = await page.evaluate(() => window.__takeoff.state.packages.filter((p) => p.auto).length);
ok('自動包標記 auto 與分組理由', autoFlag === cards);

console.log('\n【8】重整後狀態保留');
await page.reload();
await page.waitForFunction(() => window.__takeoff && window.__takeoff.state.items.length > 0);
const after = await page.evaluate(() => ({
  pkgs: window.__takeoff.state.packages.length,
  manual: window.__takeoff.state.itemByCode.get('27.15.010').qty.manual,
  draw: window.__takeoff.state.itemByCode.get('26.05.19.010').qty.drawing,
}));
ok('採購包持久化', after.pkgs === pkgTotal, `重整後 ${after.pkgs} / 預期 ${pkgTotal}`);
ok('人工確認持久化', after.manual === 5600);
ok('圖面量持久化', Math.abs(after.draw - 9.7124) < 0.001);

console.log('\n【9】無 JS 例外');
ok('頁面無未捕捉錯誤', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.close();
console.log(`\n通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);

/** 依 viewer 目前的視圖轉換，把 world 座標換成畫布上的像素座標再點下去。 */
async function clickWorld(pg, wx, wy) {
  const pt = await pg.evaluate(([x, y]) => {
    const v = window.__takeoff.state.viewer;
    const s = v.toScreen({ x, y });
    const r = v.cv.getBoundingClientRect();
    return { x: r.left + s.x, y: r.top + s.y };
  }, [wx, wy]);
  await pg.mouse.move(pt.x, pt.y);
  await pg.mouse.down();
  await pg.mouse.up();
  await pg.waitForTimeout(60);
}
