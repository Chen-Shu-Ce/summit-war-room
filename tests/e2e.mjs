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

console.log('\n【0】解析中心（預設分頁）');
ok('預設停在解析中心', await page.locator('#scanWrap.on').count() === 1);
ok('尚未載入文件時不顯示解析結果', await page.locator('#scanResult[hidden]').count() === 1);
ok('九大類分析範圍全部列出', await page.locator('#scopeBox label').count() === 10);

await page.setInputFiles('#fileDoc', [join(FIX, 'fixture-spec.txt')]);
await page.evaluate(() => { window.__takeoff.state.pendingUpKind = 'spec'; });
await page.waitForTimeout(50);
// 用 UI 的上傳按鈕路徑：先點類別，再塞檔
for (const [kind, file] of [['spec', 'fixture-spec.txt'], ['equipment', 'fixture-equip.csv'],
                            ['boq', 'fixture-boq.csv'], ['drawing', 'fixture-plan.txt'], ['drawing', 'fixture-system.txt']]) {
  await page.evaluate((k) => { window.__takeoff.state.pendingUpKind = k; }, kind);
  await page.setInputFiles('#fileDoc', join(FIX, file));
  await page.waitForFunction((n) => window.__takeoff.state.docs.some((d) => d.name === n), file);
}
const docCount = await page.evaluate(() => window.__takeoff.state.docs.length);
ok('五份文件已載入', docCount >= 5, '共 ' + docCount);
const sheetGuess = await page.evaluate(() => {
  const d = window.__takeoff.state.docs;
  return { plan: (d.find((x) => x.name.includes('plan')) || {}).sheetType, sys: (d.find((x) => x.name.includes('system')) || {}).sheetType };
});
ok('由檔名猜出平面圖／系統圖', sheetGuess.plan === 'plan' && sheetGuess.sys === 'system', JSON.stringify(sheetGuess));
const boqApplied = await page.evaluate(() => window.__takeoff.state.itemByCode.get('321.01').qty.boq);
ok('BOQ CSV 已套用到工項', boqApplied === 1650, String(boqApplied));

await page.locator('#btnAnalyze').click();
await page.waitForSelector('#scanResult:not([hidden])');
ok('九項指標全部渲染', await page.locator('#stats .stat').count() === 9);
const compTxt = (await page.locator('[data-stat="completeness"] .v').innerText()).trim();
ok('圖說完整性是算出來的百分比', /^\d{1,3}$/.test(compTxt) && +compTxt > 0 && +compTxt < 100, compTxt);
await page.locator('[data-stat="completeness"]').click();
await page.waitForSelector('#dlg[open]');
const compRows = await page.locator('#dlgBody table.fac tbody tr').count();
ok('完整性可攤開五項權重', compRows === 6, '列數 ' + compRows);
await page.locator('#dlgFoot button').last().click();

const rfiN = await page.evaluate(() => window.__takeoff.state.analysis.metrics.rfis.length);
ok('偵測到 RFI 候選', rfiN > 0, '共 ' + rfiN);
const types = await page.evaluate(() => [...new Set(window.__takeoff.state.analysis.metrics.rfis.map((r) => r.type))]);
ok('抓到圖說≠規範（SUS304 vs SUS316）', types.includes('drawing-vs-spec'), types.join(','));
ok('抓到平面圖≠系統圖（MCC 3 vs 2）', types.includes('plan-vs-system'), types.join(','));
ok('抓到圖說≠BOQ', types.includes('drawing-vs-boq'), types.join(','));
ok('抓到數量無法判斷', types.includes('qty-undeterminable'), types.join(','));
ok('抓到規格不完整', types.includes('spec-incomplete'), types.join(','));
const firstRfi = await page.locator('.rfi').first().innerText();
ok('RFI 卡片顯示候選狀態與發問對象', firstRfi.includes('候選') && firstRfi.includes('建議發問對象'), firstRfi.replace(/\s+/g, ' ').slice(0, 110));
ok('候選不配正式文號', !/RFI-\d/.test(firstRfi), firstRfi.slice(0, 60));
const rfiDl = page.waitForEvent('download');
await page.locator('#btnRfiCsv').click();
const rfiCsv = await readFile(await (await rfiDl).path(), 'utf8');
ok('RFI CSV 含問題內容與證據欄', rfiCsv.includes('問題內容') && rfiCsv.includes('證據'));

await page.locator('#tabList').click();

console.log('\n【1】版面與初始資料');
ok('WBS 樹有節點', await page.locator('#tree .node').count() > 5);
ok('BOM 表格有列', await page.locator('#boqBody tr[data-code]').count() > 10);
const cable = page.locator('tr[data-code="321.01"]');
ok('附件一工項存在', await cable.count() === 1);
const sug = (await cable.locator('td.sug').innerText()).trim();
ok('建議採購量 = 1,751 M', sug.startsWith('1,751'), sug);
const varChip = (await cable.locator('td').nth(5).innerText()).trim();
ok('差異顯示 +60 / 3.6%', varChip.includes('60') && varChip.includes('3.6'), varChip);
const band = (await cable.locator('[data-conf]').innerText()).trim();
ok('可信度顯示等級與分數', /^A \d+/.test(band), band);

console.log('\n【2】WBS 父子連動多選');
await page.locator('#tree input[data-node="300"]').check();
const selAfter = await page.evaluate(() => window.__takeoff.state.selected.size);
ok('勾選父節點會帶入所有子孫工項', selAfter === 10, '選到 ' + selAfter);
const indet = await page.evaluate(() => {
  const cb = document.querySelector('#tree input[data-node="320"]');
  return cb ? cb.checked : null;
});
ok('子節點同步為勾選', indet === true);
await page.locator('tr[data-code="321.01"] input[data-pick]').uncheck();
const half = await page.evaluate(() => document.querySelector('#tree input[data-node="300"]').indeterminate);
ok('取消單項後父節點呈半選', half === true);
await page.locator('tr[data-code="321.01"] input[data-pick]').check();

console.log('\n【3】差異超標會鎖定並擋下轉採購');
const cat6 = page.locator('tr[data-code="710.01"]');
ok('Cat.6A 差異 11.9% 被鎖定', (await cat6.innerText()).includes('鎖定'));
ok('鎖定項目無建議採購量', (await cat6.locator('td.sug').innerText()).trim() === '—');

console.log('\n【4】人工確認流程');
await page.locator('tr[data-code="710.01"] [data-src]').click();
await page.waitForSelector('#dlg[open]');
await page.fill('#dlgBody input[data-q="manual"]', '5600');
await page.fill('#mBy', '電氣工程師');
await page.fill('#mNote', '現場複核含機櫃內佈線');
await page.locator('#dlgFoot button.primary').click();
await page.waitForSelector('#dlg[open]', { state: 'hidden' });
const cat6b = (await page.locator('tr[data-code="710.01"]').innerText());
ok('人工確認後解除鎖定', !cat6b.includes('鎖定'), cat6b.replace(/\s+/g, ' ').slice(0, 120));
const sug2 = (await page.locator('tr[data-code="710.01"] td.sug').innerText()).trim();
ok('5600 × 1.08 = 6,048 M', sug2.startsWith('6,048'), sug2);
const order2 = (await page.locator('tr[data-code="710.01"] td').nth(10).innerText()).trim();
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
ok('E-CABLE-PWR 自動猜到電纜工項', mapped.some(([l, v]) => l === 'E-CABLE-PWR' && v.startsWith('321.')), JSON.stringify(mapped));
ok('E-LITE 自動猜到照明工項', mapped.some(([l, v]) => l === 'E-LITE' && v.startsWith('331.')), JSON.stringify(mapped));
await page.locator('#dlgFoot button.primary').click();
await page.waitForTimeout(200);
const drawQty = await page.evaluate(() => {
  const s = window.__takeoff.state;
  const cable = s.itemByCode.get('321.01');
  const lite = s.itemByCode.get('331.01');
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
await page.selectOption('#asItem', '410.01');
await page.selectOption('#asMode', 'set');
await page.locator('#dlgFoot button.primary').click();
await page.waitForTimeout(150);
const assigned = await page.evaluate(() => {
  const it = window.__takeoff.state.itemByCode.get('410.01');
  return { q: it.qty.drawing, src: it.drawingSource, cal: it.calibration, prov: it.provenance && it.provenance.kind };
});
ok('量測值寫入圖面量', Math.abs(assigned.q - 15) / 15 < 0.01, JSON.stringify(assigned));
ok('標記為實測且記錄校正方式', assigned.src === 'measure' && assigned.cal === 'two-point', JSON.stringify(assigned));

console.log('\n【7a】RFI 狀態流');
await page.locator('#tabScan').click();
// 挑一筆有工項的候選，跑完整流程：發出 → 回覆 → 結案並回寫工項
const pick = await page.evaluate(() => {
  const { A, state } = window.__takeoff;
  const r = A.resolveRfis({ items: state.items, docs: state.docs, settings: state.settings, scope: state.scope, rfiLog: state.rfiLog })
    .find((x) => x.status === 'candidate' && x.itemCode && x.type === 'drawing-vs-boq');
  return r ? { id: r.id, itemCode: r.itemCode } : null;
});
ok('找得到可操作的候選 RFI', !!pick);
await page.evaluate((id) => document.querySelector(`[data-rfi="issue"][data-id="${id}"]`).click(), pick.id);
await page.waitForSelector('#dlg[open]');
ok('發出對話框預告文號 RFI-001', (await page.locator('#dlgBody').innerText()).includes('RFI-001'));
await page.fill('#rDoc', '函字第 001 號');
await page.fill('#rBy', '採購工程師');
await page.locator('#dlgFoot button.primary').click();
await page.waitForTimeout(250);
if (await page.locator('#dlg[open]').count()) await page.locator('#dlgFoot button').last().click();
const issued = await page.evaluate((id) => window.__takeoff.state.rfiLog[id], pick.id);
ok('發出後配得正式文號並凍結內容', issued.code === 'RFI-001' && issued.status === 'issued' && !!issued.snapshot, JSON.stringify(issued.code));
ok('公文文號有記錄', issued.docNo === '函字第 001 號');

await page.evaluate((id) => document.querySelector(`[data-rfi="answer"][data-id="${id}"]`).click(), pick.id);
await page.waitForSelector('#dlg[open]');
await page.fill('#aText', '經查應以圖面量為準，請辦理數量變更。');
await page.fill('#aBy', '設計單位 王工程師');
await page.locator('#dlgFoot button.primary').click();
await page.waitForTimeout(250);
ok('回覆已登記', (await page.evaluate((id) => window.__takeoff.state.rfiLog[id].status, pick.id)) === 'answered');

await page.evaluate((id) => document.querySelector(`[data-rfi="close"][data-id="${id}"]`).click(), pick.id);
await page.waitForSelector('#dlg[open]');
await page.selectOption('#cAct', 'adopt-qty');
await page.waitForTimeout(80);
await page.fill('#cVal', '5820');
await page.locator('#dlgFoot button.primary').click();
await page.waitForTimeout(300);
if (await page.locator('#dlg[open]').count()) await page.locator('#dlgFoot button').last().click();
const written = await page.evaluate((c) => {
  const it = window.__takeoff.state.itemByCode.get(c);
  return { manual: it.qty.manual, by: it.manualBy, note: it.manualNote };
}, pick.itemCode);
ok('結案時把回覆數量回寫工項', written.manual === 5820, JSON.stringify(written));
ok('簽核人記為回覆人', written.by === '設計單位 王工程師', String(written.by));
ok('確認理由帶入文號與回覆原文', /RFI-001/.test(written.note) && /數量變更/.test(written.note), String(written.note));

console.log('\n【7b-gate】RFI 擋採購閘門');
const blockedBefore = await page.evaluate(() => {
  const { A, state } = window.__takeoff;
  const rfis = A.resolveRfis({ items: state.items, docs: state.docs, settings: state.settings, scope: state.scope, rfiLog: state.rfiLog });
  return [...A.blockingRfiItems(rfis, state.settings).keys()];
});
ok('有工項因未結案 RFI 被擋', blockedBefore.length > 0, '被擋 ' + blockedBefore.length + ' 項');
await page.locator('#tabList').click();
await page.evaluate((codes) => { window.__takeoff.state.selected = new Set(codes.slice(0, 1)); window.__takeoff.renderAll(); }, blockedBefore);
const gateRow = await page.locator('#boqBody tr').filter({ hasText: '不得轉採購' }).first().innerText();
ok('清單列出擋下的原因與出路', gateRow.includes('未結案 RFI') && gateRow.includes('不追'), gateRow.replace(/\s+/g, ' ').slice(0, 90));
await page.evaluate(() => { window.__takeoff.state.selected = new Set(); });

// 把其餘未結案 RFI 以「不追」清掉（必須留理由），讓後續採購包測試回到乾淨狀態
const dismissed = await page.evaluate(() => {
  const { A, state } = window.__takeoff;
  let log = state.rfiLog;
  const rfis = A.resolveRfis({ items: state.items, docs: state.docs, settings: state.settings, scope: state.scope, rfiLog: log });
  let n = 0;
  for (const r of rfis) {
    if (!A.isRfiOpen(r)) continue;
    const res = A.dismissRfi(log, r, { reason: 'e2e：本輪不追' });
    if (!res.error) { log = res.log; n++; }
  }
  state.rfiLog = log;
  window.__takeoff.runAnalysis();
  return n;
});
ok('不追需填理由且可批次處理', dismissed > 0, '處理 ' + dismissed + ' 筆');
const blockedAfter = await page.evaluate(() => {
  const { A, state } = window.__takeoff;
  const rfis = A.resolveRfis({ items: state.items, docs: state.docs, settings: state.settings, scope: state.scope, rfiLog: state.rfiLog });
  return A.blockingRfiItems(rfis, state.settings).size;
});
ok('全部處理後閘門放行', blockedAfter === 0, '仍被擋 ' + blockedAfter);

console.log('\n【7】採購包與匯出');
await page.locator('#tabList').click();
await page.evaluate(() => {
  const s = window.__takeoff.state;
  s.selected = new Set(['321.01', '320.01', '310.01']);
});
await page.locator('#btnRmSel').click();      // 觸發重繪
await page.evaluate(() => {
  const s = window.__takeoff.state;
  s.selected = new Set(['321.01', '320.01', '310.01']);
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
const payTxt = await page.locator('tr[data-code="620.01"] .pay').innerText();
ok('實作實算下標示可計價增量', payTxt.includes('可計價增量'), payTxt);
const payNote = await page.locator('tr[data-code="620.01"] .pay').getAttribute('title');
ok('滑鼠提示帶出估驗計量說明', /實作實算/.test(payNote), String(payNote).slice(0, 60));
const payDown = await page.locator('tr[data-code="420.01"] .pay').innerText();
ok('實作量低於標單標示計價減量', payDown.includes('計價減量'), payDown);
await page.locator('#btnSettings').click();
await page.waitForSelector('#dlg[open]');
ok('參數頁預設容忍 5%', await page.inputValue('#sWarn') === '0.05', await page.inputValue('#sWarn'));
ok('參數頁預設實作實算', await page.inputValue('#sContract') === 'remeasure');
await page.selectOption('#sContract', 'lumpsum');
await page.locator('#dlgFoot button.primary').click();
await page.waitForTimeout(150);
const payLump = await page.locator('tr[data-code="620.01"] .pay').innerText();
ok('切成總價承攬後改標自行吸收風險', payLump.includes('自行吸收'), payLump);
await page.locator('#btnSettings').click();
await page.waitForSelector('#dlg[open]');
await page.selectOption('#sContract', 'remeasure');
await page.locator('#dlgFoot button.primary').click();
await page.waitForTimeout(150);

console.log('\n【7c】自動建議拆包');
await page.evaluate(() => {
  window.__takeoff.state.selected = new Set(['321.01', '320.01', '310.01', '420.01', '620.01']);
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
  manual: window.__takeoff.state.itemByCode.get('710.01').qty.manual,
  draw: window.__takeoff.state.itemByCode.get('321.01').qty.drawing,
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
