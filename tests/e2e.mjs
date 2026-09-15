/**
 * e2e.mjs — 用 Chromium 實際開頁面，驗證三欄互動、DXF 自動抓量、PDF 校正量測、採購包與匯出。
 * 執行： node tests/e2e.mjs   （需要本機已安裝 playwright 與 Chromium）
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readXlsx } from './lib-zip.mjs';

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
const S_diff = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
const ok = (name, cond, extra = '') => { cond ? (pass++, console.log('  ok  ', name)) : (fail++, console.log('  FAIL', name, extra)); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  // /api/market-data 是可選的加值端點：靜態測試伺服器上不存在，程式已處理並退回種子檔。
  // 瀏覽器仍會把失敗的 fetch 記到 console，那不是未捕捉錯誤。其餘一律計入。
  const loc = (m.location && m.location().url) || '';
  if (loc.includes('/api/market-data') && /404|Failed to load resource/.test(m.text())) return;
  errors.push('console: ' + m.text());
});

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
const rfiXl = readXlsx(await readFile(await (await rfiDl).path()));
ok('RFI Excel 含問題內容與證據欄', rfiXl.text.includes('問題內容') && rfiXl.text.includes('證據'));
await closeDialog(page);

await page.locator('#tabList').click();

// 預設會在換圖時清掉上一張圖產生的圖面量（使用者指定）。
// 先驗證這個預設確實生效，再把它關掉 —— 後面多數段落是「載入多張圖、
// 數量要累積下去」的情境，開著會一直被清掉。〈7之六〉會自己再打開來測。
ok('預設就是「清除上一張圖產生的圖面量」', await page.evaluate(() => {
  const s = window.__takeoff.state.settings;
  return (s.clearOnDrawingChange || 'prev') === 'prev';
}));
await page.evaluate(() => { window.__takeoff.state.settings.clearOnDrawingChange = 'keep'; });

console.log('\n【1】版面與初始資料');
ok('WBS 樹有節點', await page.locator('#tree .node').count() > 5);
ok('BOM 表格有列', await page.locator('#boqBody tr[data-code]').count() > 10);
const cable = page.locator('tr[data-code="321.01"]');
ok('附件一工項存在', await cable.count() === 1);
const sug = (await cable.locator('td.sug').innerText()).trim();
ok('預設 P80 建議採購量 = 1,777.14 M', sug.startsWith('1,777.14'), sug);
const wasteCell = (await cable.locator('td').nth(8).innerText()).trim();
ok('損耗率欄顯示有效值與服務水準', wasteCell.includes('4.54') && wasteCell.includes('P80'), wasteCell);
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
ok('人工確認 5600 套 P80 損耗 → 6,225.78 M', sug2.startsWith('6,225.78'), sug2);
const order2 = (await page.locator('tr[data-code="710.01"] td').nth(10).innerText()).trim();
ok('305M/箱 → 21 箱（P80 多一箱）', order2.startsWith('21 箱'), order2);

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
// E-CABLE-PWR 刻意「不」自動對應：範本裡 321.01（38mm²）與 321.02（22mm²）
// 的 layerHints 都是 E-CABLE-PWR，而一條線在幾何上看不出是哪一種。
// 舊版會安靜地挑先出現的那個，把整層長度算到它頭上 —— 那是靜默的錯帳。
ok('共用關鍵字的圖層不自動對應，留白待人工指定',
  mapped.some(([l, v]) => l === 'E-CABLE-PWR' && v === ''), JSON.stringify(mapped));
const tie = await page.evaluate(() => {
  const m = window.__takeoff.LM.match('E-CABLE-PWR', window.__takeoff.state.items, null);
  return { best: m.best, amb: m.ambiguous };
});
ok('並且明確指出是哪兩個工項分不開', tie.best === null
  && tie.amb.includes('321.01') && tie.amb.includes('321.02'), JSON.stringify(tie));
ok('對話框說明無法分辨的原因', (await page.locator('#dlgBody').innerText()).includes('無法分辨'));
ok('E-LITE 自動猜到照明工項', mapped.some(([l, v]) => l === 'E-LITE' && v.startsWith('331.')), JSON.stringify(mapped));
ok('每一列都寫出判定依據，不是黑箱',
  (await page.locator('#dlgBody').innerText()).includes('圖層關鍵字'));
// 「無法分辨」是擋住不讓套用，不是只給個警告 —— 下拉選單本身就是停用的
ok('無法分辨的圖層，下拉選單被停用（擋住不讓套用）', await page.evaluate(() => {
  const sel = [...document.querySelectorAll('#dlgBody [data-map]')]
    .find((s) => s.parentElement.querySelector('.lname').textContent === 'E-CABLE-PWR');
  return !!sel && sel.disabled;
}));
// 幾何本身仍然算得出來 —— 被擋下的是「算到哪個工項」，不是「算不算得出來」
// 電纜圖層 = 5000 + π/2·1000 + π·1000 mm = 9.712m
const cableGeom = await page.evaluate(() => {
  const g = window.__takeoff.DXF.aggregateByLayer(window.__takeoff.state.viewer.doc)
    .find((x) => x.layer === 'E-CABLE-PWR');
  return g.length * window.__takeoff.state.viewer.metersPerUnit;
});
ok('圖層幾何量算得正確 (9.7124 M)', Math.abs(cableGeom - 9.7124) < 0.001, String(cableGeom));
await page.locator('#dlgFoot button.primary').click();
await page.waitForTimeout(300);
ok('套用後給出的是結果報告，不是只報成功數',
  (await page.locator('#dlgTitle').innerText()).includes('自動抓量結果'),
  await page.locator('#dlgTitle').innerText());
const report = await page.locator('#dlgBody').innerText();
ok('漏項清單列出被擋下的圖層', report.includes('漏項清單') && report.includes('E-CABLE-PWR'), report.slice(0, 200));
ok('並寫明被擋下的原因', report.includes('無法分辨'), report.slice(0, 260));
await closeDialog(page, 4);
const drawQty = await page.evaluate(() => {
  const s = window.__takeoff.state;
  return { cable: s.itemByCode.get('321.01').qty.drawing,
    lite: s.itemByCode.get('331.01').qty.drawing,
    liteProv: s.itemByCode.get('331.01').provenance };
});
ok('被擋下的圖層沒有寫進任何數量', drawQty.cable !== 9.7124, String(drawQty.cable));
ok('燈具計數由圖塊寫入 (4)', drawQty.lite === 4, String(drawQty.lite));
ok('留下數量出處', drawQty.liteProv && drawQty.liteProv.kind === 'dxf-layer'
  && drawQty.liteProv.layer === 'E-LITE', JSON.stringify(drawQty.liteProv));

console.log('\n【6】PDF 載入、比例校正與量測');
await page.setInputFiles('#fileDrawing', join(FIX, 'fixture.pdf'));
await page.waitForFunction(() => window.__takeoff.state.viewer.mode === 'pdf' && !!window.__takeoff.state.viewer.raster);
await page.waitForSelector('#dlg[open]');
ok('PDF 未校正時警告', (await page.locator('#dlgBody').innerText()).includes('未設定比例'));
await page.locator('#dlgFoot button').last().click();
await page.waitForTimeout(300);
// 換圖預設會清掉上一張圖產生的圖面量，並跳一次說明 —— 關掉再往下走
await closeDialog(page, 4);
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

console.log('\n【6b】損耗率機率模型');
await page.locator('#tabList').click();
await page.locator('tr[data-code="321.01"] td.sug [data-dist]').click();
await page.waitForSelector('#dlg[open]');
const distTxt = await page.locator('#dlgBody').innerText();
ok('分布對話框列出 P5/P50/P80/P90/P95', ['P5', 'P50', 'P80', 'P90', 'P95'].every((x) => distTxt.includes(x)));
ok('揭露慣用單點值相當於第幾百分位', /相當於\s*P3\d/.test(distTxt) && distTxt.includes('機率會不夠'), distTxt.replace(/\s+/g, ' ').slice(0, 140));
ok('給出服務水準建議與理由', distTxt.includes('系統建議') && distTxt.includes('缺料'), '');
ok('標明區間為慣例值非實證資料', distTxt.includes('慣例值') && distTxt.includes('實證'), '');
// 採用 P95 後數量應變大
const before95 = await page.evaluate(() => window.__takeoff.Q.suggestPurchase(
  window.__takeoff.R.withServiceLevel(window.__takeoff.state.itemByCode.get('321.01'), window.__takeoff.state.settings),
  window.__takeoff.state.settings).suggestQty);
await page.locator('#dlgBody [data-setsl="0.95"]').click();
await page.waitForTimeout(200);
const after95 = await page.evaluate(() => window.__takeoff.state.itemByCode.get('321.01').serviceLevel);
ok('可就地改用 P95', after95 === 0.95);
const sug95 = (await page.locator('tr[data-code="321.01"] td.sug').innerText()).trim();
ok('P95 採購量高於 P80', parseFloat(sug95.replace(/,/g, '')) > before95, sug95);
await page.evaluate(() => { delete window.__takeoff.state.itemByCode.get('321.01').serviceLevel; window.__takeoff.renderAll(); });

// 計數類不該有假分布
await page.locator('tr[data-code="310.01"] td.sug').click();
const cntHasBtn = await page.locator('tr[data-code="310.01"] td.sug [data-dist]').count();
ok('計數類不提供分布（6 台配電盤沒有損耗分布）', cntHasBtn === 0);

console.log('\n【6c】整包風險模擬');
await page.evaluate(() => {
  window.__takeoff.state.selected = new Set(window.__takeoff.state.items.filter((i) => ['length', 'area'].includes(i.measureType)).map((i) => i.code));
  window.__takeoff.renderAll();
});
await page.locator('#btnSim').click();
await page.waitForSelector('#dlg[open]');
const simTxt = await page.locator('#dlgBody').innerText();
ok('列出整包金額分位', simTxt.includes('整包 P80') && simTxt.includes('各項 P80 直接相加'));
ok('揭露分散效益', simTxt.includes('分散效益'));
ok('對照 ρ=0 / ρ=設定 / ρ=1', simTxt.includes('各項獨立') && simTxt.includes('完全同步'));
ok('回報收斂指標', simTxt.includes('收斂指標'));
const simNums = await page.evaluate(() => {
  const { R, state } = window.__takeoff;
  const list = state.items.filter((i) => state.selected.has(i.code));
  const a = R.simulatePortfolio(list, state.settings, { correlation: state.settings.correlation });
  const b = R.simulatePortfolio(list, state.settings, { correlation: 0 });
  return { sum: a.sumOfP80, port: a.portfolioP80, div: a.diversification, indep: b.cost.p80, conv: a.convergence };
});
ok('各項 P80 相加 > 整包 P80', simNums.sum > simNums.port, JSON.stringify(simNums));
ok('獨立假設會低估整包 P80', simNums.indep < simNums.port, JSON.stringify(simNums));
ok('收斂指標 < 2%', simNums.conv < 0.02, String(simNums.conv));
const simDl = page.waitForEvent('download');
await page.locator('#dlgFoot button').filter({ hasText: '匯出' }).click();
const simXl = readXlsx(await readFile(await (await simDl).path()));
ok('模擬 Excel 含參數與逐項分位',
  simXl.text.includes('模擬參數') && simXl.text.includes('分散效益') && simXl.text.includes('P80'));
await closeDialog(page);

console.log('\n【6d】關閉機率模式回到你現有報表的數字');
await page.locator('#btnSettings').click();
await page.waitForSelector('#dlg[open]');
await page.selectOption('#sStoch', '0');
await page.locator('#dlgFoot button.primary').click();
await page.waitForTimeout(250);
const sugDet = (await page.locator('tr[data-code="321.01"] td.sug').innerText()).trim();
ok('關閉機率模式 → 1,751 M（附件一的數字）', sugDet.startsWith('1,751'), sugDet);
await page.locator('#btnSettings').click();
await page.waitForSelector('#dlg[open]');
await page.selectOption('#sStoch', '1');
await page.locator('#dlgFoot button.primary').click();
await page.waitForTimeout(250);
await page.evaluate(() => { window.__takeoff.state.selected = new Set(); window.__takeoff.renderAll(); });

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

console.log('\n【7之九】BOM → 請購單 → 發包單');
// 使用者要的：BOM 明細一鍵轉 PR、算出成本與建議廠商，再轉 PO。
// 一鍵是省掉點擊，不是省掉檢查 —— 採購閘門照擋。
await page.locator('#tabList').click();
await page.waitForTimeout(200);
await closeDialog(page, 6);

// 廠商主檔
await page.locator('#btnVendors').click();
await page.waitForSelector('#dlg[open]');
await page.locator('#vLoadDemo').click();
await page.waitForTimeout(800);
const vTxt = await page.locator('#dlgBody').innerText();
ok('載入廠商主檔', await page.evaluate(() => window.__takeoff.state.vendors.length) === 5);
ok('示範資料要明確標示為虛構', vTxt.includes('全部虛構'), vTxt.slice(0, 80));
ok('資格過期的廠商在主檔就標成不可用', vTxt.includes('2020-12-31'), vTxt.slice(0, 400));
ok('關係人疑慮：共用電話／地址／負責人／匯款帳戶都抓得到',
  ['聯絡電話', '地址', '負責人', '匯款帳戶'].every((k) => vTxt.includes(k)), vTxt.slice(0, 600));
ok('明說這是事實比對不是指控', vTxt.includes('不是指控'));
await closeDialog(page, 6);

// 一鍵轉 PR
await page.evaluate(() => {
  const s = window.__takeoff.state;
  s.selected = new Set(['321.01', '322.01', '320.01', '310.01']);
  window.__takeoff.renderAll();
});
await page.locator('#btnQuickPr').click();
await page.waitForSelector('#dlg[open]');
await page.waitForTimeout(400);
const qTxt = await page.locator('#dlgBody').innerText();
ok('算出直接成本', /直接成本（未稅）/.test(qTxt) && /NT\$ [\d,]+/.test(qTxt), qTxt.slice(0, 160));
ok('算出最長前置期與建議到貨日', qTxt.includes('最長前置期') && qTxt.includes('建議需求到貨日'));
ok('建議廠商附分數、資料完整度與依據',
  qTxt.includes('分數') && qTxt.includes('資料完整度') && qTxt.includes('交期達成率'), qTxt.slice(0, 500));
ok('不符資格的廠商被排除，且說明是「不能用」不是扣分',
  qTxt.includes('資格不符被排除') && qTxt.includes('不是扣分'), qTxt.slice(0, 900));
ok('明說一鍵不省檢查', qTxt.includes('省掉點擊'), qTxt.slice(-400));

const quickSug = await page.evaluate(() => {
  const { VD, state } = window.__takeoff;
  return VD.suggest(state.vendors, { categories: ['321', '322', '320', '310'], amount: 4000000, needDate: '2027-06-01' });
});
ok('品類全涵蓋的廠商排第一', quickSug.best === 'DEMO-A', JSON.stringify(quickSug.ranked.map((x) => [x.code, x.score])));
ok('品類完全不符者被否決而非低分', quickSug.blocked.some((b) => b.code === 'DEMO-E'), JSON.stringify(quickSug.blocked.map((x) => x.code)));

await page.fill('#qReq', '採購 王小明');
await page.fill('#qConf', '電氣技師 李四');
await page.locator('#dlgFoot button.primary').click();
await page.waitForTimeout(900);
const made = await page.evaluate(() => {
  const s = window.__takeoff.state;
  return { prs: s.prs.length, bls: s.baselines.length, pkgs: s.packages.length, prNo: s.prs[s.prs.length - 1].no };
});
ok('一鍵同時建立採購包、基準版、請購單三筆紀錄',
  made.prs === 1 && made.bls >= 1 && made.pkgs >= 1, JSON.stringify(made));
ok('產生後直接開啟請購單', (await page.locator('#dlgTitle').innerText()).includes(made.prNo));

// 轉 PO
await page.locator('#dlgFoot button').filter({ hasText: '轉發包單' }).click();
await page.waitForTimeout(700);
ok('開啟轉發包單視窗', (await page.locator('#dlgTitle').innerText()).includes('轉發包單'));
const oTxt = await page.locator('#dlgBody').innerText();
ok('列出可開量與估價單價', oTxt.includes('可開量') && oTxt.includes('估價單價'), oTxt.slice(-500));
ok('明說議定價與估價分開存', oTxt.includes('分開存'), oTxt.slice(-300));

await page.selectOption('#oVend', 'DEMO-A');
await page.fill('#oBy', '採購 王小明');
// 第一項殺價 5%
const negotiated = await page.evaluate(() => {
  const el = document.querySelector('[data-op="0"]');
  const est = parseFloat(el.value);
  el.value = (est * 0.95).toFixed(2);
  return { est, neg: parseFloat(el.value), qty: parseFloat(document.querySelector('[data-oq="0"]').value) };
});
await page.locator('#dlgFoot button.primary').click();
await page.waitForTimeout(900);
ok('發包單建立並開啟', (await page.locator('#dlgTitle').innerText()).includes('發包單 PO-'),
  await page.locator('#dlgTitle').innerText());
const po = await page.evaluate(() => window.__takeoff.state.pos[0]);
ok('估價單價沒有被議定價覆蓋', po.lines[0].estUnitPrice === negotiated.est,
  `${po.lines[0].estUnitPrice} vs ${negotiated.est}`);
ok('議定單價存在自己的欄位', Math.abs(po.lines[0].unitPrice - negotiated.neg) < 0.01);
ok('議價差額算得對（手算）',
  Math.abs(po.variance - (negotiated.neg - negotiated.est) * negotiated.qty) < 1,
  `${po.variance} vs ${(negotiated.neg - negotiated.est) * negotiated.qty}`);
ok('談下來的差額是負數', po.variance < 0, String(po.variance));
ok('每一列都記得來源 PR', po.lines.every((l) => l.prNo === made.prNo));
ok('付款條件由廠商主檔帶出', po.paymentTerms.includes('60'), po.paymentTerms);
const poTxt = await page.locator('#dlgBody').innerText();
ok('集中度警示：這家佔 100%', poTxt.includes('100%') && poTxt.includes('單一廠商出事'), poTxt.slice(0, 400));

// 超發必須被擋
const over = await page.evaluate(() => {
  const { PO, state } = window.__takeoff;
  const pr = state.prs[0];
  const first = state.pos[0];
  const code = first.lines[0].code;
  const prQty = pr.lines.find((l) => (l.itemCode || l.code) === code).qty;
  const r = PO.createPo(pr, { code: 'DEMO-B', name: '示範Ｂ電機（虛構）' },
    { by: 'A', lines: [{ code, qty: prQty }] }, state.pos);
  return { error: r.error || '', why: (r.rejected || [])[0] ? r.rejected[0].why : '' };
});
ok('同一工項再開一次會被擋（超發）', !!over.error, JSON.stringify(over));
ok('並說出請購多少、已開多少、超出多少', /超發/.test(over.why) && /已開/.test(over.why), over.why);

// 狀態機
const st = await page.evaluate(() => {
  const { PO, state } = window.__takeoff;
  const issued = PO.setStatus(state.pos[0], 'issued', '王').po;
  return { ok: issued.status, back: PO.setStatus(issued, 'draft').error || '' };
});
ok('狀態可以往前走', st.ok === 'issued');
ok('但不能倒退 —— 已發出的契約文件不能偷偷改', /不可從/.test(st.back), st.back);

// 匯出
const poDl = page.waitForEvent('download');
await page.locator('#dlgFoot button').filter({ hasText: '匯出' }).click();
const poXl = readXlsx(await readFile(await (await poDl).path()));
ok('發包單可匯出 Excel（表頭 + 明細兩張工作表）', poXl.sheets.length === 2,
  poXl.sheets.map((s) => s.name).join('|'));
ok('匯出同時含估價單價與議定單價', poXl.text.includes('估價單價') && poXl.text.includes('議定單價'));
ok('匯出含議價差額', poXl.text.includes('議價差額'));
await closeDialog(page, 6);

// 右欄列表
ok('右欄出現發包單', await page.locator('#pos .bl').count() === 1);
ok('發包單計數正確', (await page.locator('#poCount').innerText()) === '1');

// 還原，不要污染後面的段落
await page.evaluate(() => {
  const s = window.__takeoff.state;
  s.pos = []; s.prs = []; s.baselines = []; s.packages = []; s.vendors = []; s.selected = new Set();
  window.__takeoff.renderAll();
});

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
const xl = readXlsx(await readFile(await (await dl).path()));
ok('匯出的是單張工作表的活頁簿', xl.sheets.length === 1, String(xl.sheets.length));
const head = xl.sheets[0].rows[0];
ok('Excel 含表頭與稽核欄',
  ['正式採購基準', '判定規則', '數量出處', '確認理由'].every((h) => head.includes(h)), head.join('|').slice(0, 160));
ok('Excel 含 P80 建議採購量（全精度）', xl.text.includes('1777.1'), (xl.sheets[0].rows[1] || []).join(',').slice(0, 140));
ok('中文沒有亂碼', xl.text.includes('低壓電力電纜'), xl.text.slice(0, 80));
await closeDialog(page);   // 匯出對話框現在會留著（多一條複製貼上的路）

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

console.log('\n【7d】基準版與請購單');
await page.locator('.pkg [data-pkg-freeze]').first().click();
await page.waitForSelector('#dlg[open]');
await page.locator('#dlgFoot button.primary').click();
await page.waitForTimeout(200);
ok('沒有工程確認人不得凍結', (await page.locator('#dlgBody').innerText()).includes('工程確認人'));
await page.locator('#dlgFoot button').last().click();

await page.locator('.pkg [data-pkg-freeze]').first().click();
await page.waitForSelector('#dlg[open]');
await page.fill('#bBy', '工程部 李經理');
await page.fill('#bNote', 'e2e 凍結');
await page.locator('#dlgFoot button.primary').click();
await page.waitForTimeout(250);
if (await page.locator('#dlg[open]').count()) await page.locator('#dlgFoot button').last().click();
const bl1 = await page.evaluate(() => window.__takeoff.state.baselines[0]);
ok('基準版已建立且 rev=1', bl1 && bl1.rev === 1 && bl1.confirmedBy === '工程部 李經理', JSON.stringify(bl1 && bl1.code));
ok('基準版卡片顯示未異動', (await page.locator('.bl').first().innerText()).includes('未異動'));

// 改一個數量，基準版要抓出變更
const firstCode = bl1.items[0].code;
await page.evaluate((c) => {
  const it = window.__takeoff.state.itemByCode.get(c);
  it.qty.manual = (it.qty.manual || it.qty.drawing || it.qty.boq) + 100;
  it.manualBy = 'e2e'; it.manualNote = 'e2e 加量';
  window.__takeoff.renderAll();
}, firstCode);
await page.waitForTimeout(200);
const blTxt = await page.locator('.bl').first().innerText();
ok('凍結後的異動會被標出來', /變更\s*\d/.test(blTxt) && blTxt.includes('金額差'), blTxt.replace(/\s+/g, ' ').slice(0, 110));
const rowChg = await page.locator('#boqBody tr').filter({ hasText: '較 BL-' }).first().innerText();
ok('清單列出較基準版的欄位差異', rowChg.includes('基準量') && rowChg.includes('+100'), rowChg.replace(/\s+/g, ' ').slice(0, 90));

await page.locator('.bl [data-bldiff]').first().click();
await page.waitForSelector('#dlg[open]');
const diffTxt = await page.locator('#dlgBody').innerText();
ok('變更對照列出基準版與現值', diffTxt.includes('基準版') && diffTxt.includes('建議採購量'), diffTxt.replace(/\s+/g, ' ').slice(0, 100));
await page.locator('#dlgFoot button').first().click();

// 產生請購單：缺料號要先補
await page.locator('.bl [data-blpr]').first().click();
await page.waitForSelector('#dlg[open]');
const prDlg = await page.locator('#dlgBody').innerText();
ok('PR 單號符合 PR-YYYYMMDD0001 格式', /PR-\d{8}0001/.test(prDlg), prDlg.slice(0, 80));
ok('流水號重置說明為每日', prDlg.includes('每日重置'), prDlg.slice(0, 120));
const missing = await page.locator('#dlgBody [data-erp]').count();
ok('缺 ERP 料號會先擋下並提供補填', missing > 0, '缺 ' + missing + ' 項');
for (let i = 0; i < missing; i++) await page.locator('#dlgBody [data-erp]').nth(i).fill(`ERP-${1000 + i}`);
await page.fill('#pReq', '採購 陳小姐');
await page.fill('#pNeed', '2026-12-01');
await page.locator('#dlgFoot button.primary').click();
await page.waitForSelector('#dlg[open]');
await page.waitForTimeout(200);
const pr = await page.evaluate(() => window.__takeoff.state.prs[0]);
ok('請購單已產生且帶稅額', pr && /^PR-\d{8}0001$/.test(pr.no) && pr.total > pr.subtotal, JSON.stringify(pr && pr.no));
ok('料號已回寫工項', await page.evaluate((c) => !!window.__takeoff.state.itemByCode.get(c).erpCode, firstCode));
const prView = await page.locator('#dlgBody').innerText();
ok('請購單畫面列出未稅/稅額/含稅', prView.includes('未稅') && prView.includes('稅額') && prView.includes('含稅合計'));

// 欄位對映 + 匯出
await page.locator('#eMap').click();
await page.waitForSelector('#dlg[open]');
await page.fill('[data-map="header:no"]', 'PURCH_NO');
await page.fill('[data-map="line:erpCode"]', 'ITEM_NO');
await page.locator('#dlgFoot button.primary').click();
await page.waitForSelector('#dlg[open]');
await page.waitForTimeout(250);
const dlPr = page.waitForEvent('download');
await page.locator('#dlgFoot button.primary').click();
const prXl = readXlsx(await readFile(await (await dlPr).path()));
ok('ERP Excel 表頭與明細分成兩張工作表', prXl.sheets.length === 2,
  prXl.sheets.map((x) => x.name).join('|'));
ok('ERP Excel 套用自訂欄名', prXl.text.includes('PURCH_NO'), prXl.sheets[0].rows[0].join('|').slice(0, 100));
ok('ERP Excel 帶出 PR 單號', prXl.text.includes(pr.no));
await closeDialog(page);

console.log('\n【7e】施工工序');
await page.locator('#tabSeq').click();
ok('未載入工序時說明工序的用途', (await page.locator('#seqBody').innerText()).includes('誰卡誰'));
await page.locator('#btnSeqLoad').click();
await page.waitForSelector('#dlg[open]');
const loadTxt = await page.locator('#dlgBody').innerText();
ok('載入工序範本', /載入\s*63\s*道工序/.test(loadTxt), loadTxt.replace(/\s+/g, ' ').slice(0, 80));
ok('載入時即聲明範本為工程慣例非圖說要求', loadTxt.includes('工程慣例') && loadTxt.includes('建議工序'), '');
await page.locator('#dlgFoot button').last().click();
await page.fill('#seqStart', '2026-09-14');
await page.waitForTimeout(250);

const sch = await page.evaluate(() => {
  const r = window.__takeoff.state.sched;
  return { n: r.tasks.length, start: r.projectStart, finish: r.projectFinish, crit: r.criticalPath, cyc: r.cyclic.length, miss: r.missingPreds.length };
});
ok('排程無迴圈、無缺漏前置', sch.cyc === 0 && sch.miss === 0, JSON.stringify(sch));
ok('要徑抓到長交期的冰水主機', sch.crit.some((c) => c.startsWith('610')), sch.crit.join(','));
const statTxt = await page.locator('#seqStat').innerText();
ok('狀態列顯示要徑、Gate、建議工序數', statTxt.includes('要徑') && statTxt.includes('Gate') && statTxt.includes('建議工序'), statTxt);

// 工序樹
const treeTxt = await page.locator('#seqBody').innerText();
ok('工序樹依 WBS 分組', treeTxt.includes('410') && treeTxt.includes('給水'));
ok('明確警示建議工序不是圖說要求', treeTxt.includes('工程慣例，不是圖說要求'), '');
ok('標出隱蔽工程', treeTxt.includes('隱蔽'));

// Gate：點一下切換狀態，下游解除阻擋
const countBlockedBy = (code) => page.evaluate((c) => {
  const { S, state } = window.__takeoff;
  let n = 0;
  for (const gates of S.gateBlocks(state.sched.tasks).values()) if (gates.some((g) => g.code === c)) n++;
  return n;
}, code);
const gateBefore = await page.evaluate(() => window.__takeoff.S.gateBlocks(window.__takeoff.state.sched.tasks).size);
ok('有工序被未通過的 Gate 擋住', gateBefore > 0, '被擋 ' + gateBefore);
const byPressureBefore = await countBlockedBy('410-080');
ok('試壓 Gate 擋住多道下游工序', byPressureBefore > 0, '擋住 ' + byPressureBefore);
await page.locator('[data-gate="410-080"]').first().click();
await page.waitForTimeout(200);
const gs = await page.evaluate(() => window.__takeoff.state.tasks.find((t) => t.code === '410-080').gateStatus);
ok('點擊 Gate 可切換為 Pass', gs === 'pass');
ok('該 Gate 通過後不再擋任何工序', await countBlockedBy('410-080') === 0);
const gateAfter = await page.evaluate(() => window.__takeoff.S.gateBlocks(window.__takeoff.state.sched.tasks).size);
ok('但仍被其他未通過的 Gate 擋住（阻擋是逐個 Gate 判定）', gateAfter > 0 && gateAfter <= gateBefore, `${gateBefore} → ${gateAfter}`);

// 關聯表：十六欄
await page.locator('#seqView [data-sv="table"]').click();
await page.waitForTimeout(200);
const cols = await page.locator('#seqBody table.seq thead th').allInnerTexts();
ok('關聯表恰為規定的十六欄', cols.length === 16, String(cols.length));
for (const c of ['SequenceCode', 'WBS', '工序名稱', '前置工序', '關聯FS/SS', '使用BOM', '是否隱蔽', '是否Gate', '來源圖號', '可信度']) {
  ok(`關聯表含欄位「${c}」`, cols.includes(c), cols.join('|'));
}
const tblTxt = await page.locator('#seqBody').innerText();
ok('關聯表顯示 FS/SS 關聯', /FS/.test(tblTxt) && /SS/.test(tblTxt));

// 泳道圖
await page.locator('#seqView [data-sv="lane"]').click();
await page.waitForTimeout(250);
ok('泳道圖依工種分道', await page.locator('#seqBody .lane').count() >= 5);
const laneNames = await page.locator('#seqBody .lane .lname').allInnerTexts();
ok('泳道含給排水與品管', laneNames.includes('給排水') && laneNames.includes('品管'), laneNames.join(','));
ok('泳道圖有工序條塊', await page.locator('#seqBody .bar').count() > 20);
ok('要徑以紅色標示', await page.locator('#seqBody .bar.crit').count() > 0);
ok('Gate 以菱形標示', (await page.locator('#seqBody').innerText()).includes('◆'));

// 材料需求日：反推鏈
await page.locator('#seqView [data-sv="mat"]').click();
await page.waitForTimeout(250);
const matTxt = await page.locator('#seqBody').innerText();
ok('材料需求日表列出完整反推鏈', ['需求進場日', '最晚核准日', '最晚送審日', '建議發包日', '建議PR日'].every((x) => matTxt.includes(x)));
ok('說明 Lead 從送審核准後起算', matTxt.includes('送審核准後') && matTxt.includes('不是從下單起算'), '');
const chain = await page.evaluate(() => {
  const { S, state } = window.__takeoff;
  const opts = { siteBufferDays: 3, prToPoDays: 7, submittalDays: 14 };
  const chains = S.materialChains(state.sched.tasks, state.items, opts);
  const c = chains.find((x) => x.itemCode === '610.01');
  return c ? { task: c.taskCode, site: c.needOnSite, appr: c.approveBy, sub: c.submitBy, po: c.poBy, pr: c.prBy, lead: c.leadTimeDays } : null;
});
ok('冰水主機反推出完整日期鏈', !!chain, JSON.stringify(chain));
ok('核准到進場 = Lead 天數', chain && S_diff(chain.appr, chain.site) === chain.lead, JSON.stringify(chain));
ok('發包到核准 = 送審 14 天', chain && S_diff(chain.sub, chain.appr) === 14, JSON.stringify(chain));
ok('PR 到發包 = 內部核決 7 天', chain && S_diff(chain.pr, chain.po) === 7, JSON.stringify(chain));
ok('材料鏈不把送審當消耗點（送審那天材料不必進場）', chain && chain.task !== '610-010', chain && chain.task);

// 最早可行開工日：整片紅字時必須給出可執行的答案
ok('逾期時顯示最早可行開工日', matTxt.includes('最早可行開工日') || !matTxt.includes('已逾期'), '');
if (matTxt.includes('最早可行開工日')) {
  const before = await page.locator('#seqStart').inputValue();
  const suggested = await page.locator('#btnFeasApply').getAttribute('data-start');
  ok('建議開工日晚於目前開工日', suggested > before, `${before} → ${suggested}`);
  await page.locator('#btnFeasApply').click();
  await page.waitForTimeout(350);
  ok('套用後開工日改為建議值', (await page.locator('#seqStart').inputValue()) === suggested);
  const after = await page.evaluate(() => {
    const { S, state } = window.__takeoff;
    const chains = S.materialChains(state.sched.tasks, state.items, { siteBufferDays: 3, prToPoDays: 7, submittalDays: 14, today: new Date() });
    return chains.filter((c) => c.slackDays < 0).length;
  });
  ok('套用後不再有逾期材料', after === 0, `仍逾期 ${after} 項`);
  // 還原，後面的持久化測試才不受影響
  await page.evaluate((v) => { const el = document.querySelector('#seqStart'); el.value = v; el.dispatchEvent(new Event('change')); }, before);
  await page.waitForTimeout(300);
}

const seqDl = page.waitForEvent('download');
await page.locator('#btnSeqCsv').click();
const seqXl = readXlsx(await readFile(await (await seqDl).path()));
const seqHead = seqXl.sheets[0].rows[0];
ok('工序 Excel 含十六欄與排程欄',
  seqHead.includes('SequenceCode') && seqXl.text.includes('可信度') && seqXl.text.includes('浮時'),
  seqHead.join('|').slice(0, 160));
ok('工序 Excel 標示建議工序', seqXl.text.includes('建議工序／需工程確認'));
await closeDialog(page);
await page.waitForTimeout(400);

console.log('\n【6之三】掃描圖與不按比例的圖');
await page.locator('#tabView').click();
await page.setInputFiles('#fileDrawing', join(FIX, 'fixture-scan.pdf'));
await page.waitForFunction(() => window.__takeoff.state.pdfScale !== null, null, { timeout: 30000 });
await page.waitForTimeout(700);
if (await page.locator('#dlg[open]').count()) await page.locator('#dlgFoot button').last().click();
await page.waitForTimeout(200);
const sc = await page.evaluate(() => {
  const f = window.__takeoff.state.pdfScale;
  return { paper: f.paper && f.paper.name, kind: f.page.kind, text: f.page.textCount,
    images: f.page.images, paths: f.page.paths, scan: f.scan, nts: f.nts, usable: f.usable,
    hint: f.evidence.some((e) => e.kind === 'scan-noscale') };
});
ok('偵測出純掃描頁（零文字、零向量、一張影像）',
  sc.kind === 'scan' && sc.text === 0 && sc.paths === 0 && sc.images === 1, JSON.stringify(sc));
ok('掃描圖仍判得出紙張規格 A3', sc.paper === 'A3', JSON.stringify(sc));
ok('掃描圖一律判定不可直接套用比例', sc.usable === false);
ok('明說「讀不到文字所以判斷不了，請人眼確認」', sc.hint === true);
ok('讀不到 NTS 不等於不是 NTS', sc.nts === false);

await page.locator('#scaleChip').click();
await page.waitForSelector('#dlg[open]');
await page.waitForTimeout(300);
const scTxt = await page.locator('#dlgBody').innerText();
ok('對話框最上方先問「這張圖是按比例畫的嗎」', scTxt.includes('這張圖是按比例畫的嗎'), '');
ok('提醒純掃描圖工具無法自己判斷', scTxt.includes('工具無法自己判斷'), '');
// 人工勾選「不按比例」後，就算硬套比例也不給工程單位
await page.locator('#chkNts').check();
await page.waitForTimeout(300);
const ntsBlocked = await page.evaluate(() => {
  const v = window.__takeoff.state.viewer;
  v.setDeclaredScale(100);                       // 故意硬套一個比例
  const m = { type: 'length', pts: [{ x: 0, y: 0 }, { x: 200, y: 0 }] };
  const e = v.engValue(m);
  return { value: e.value, notToScale: e.notToScale, raw: e.raw, label: v.label(m),
    chip: document.querySelector('#scaleChip').textContent };
});
ok('標為不按比例後，硬套比例也不給工程單位',
  ntsBlocked.value === null && ntsBlocked.notToScale === true, JSON.stringify(ntsBlocked));
ok('量測標籤直接標示「不按比例」', /不按比例/.test(ntsBlocked.label), ntsBlocked.label);
ok('比例晶片顯示「不按比例（量測無意義）」', /不按比例/.test(ntsBlocked.chip), ntsBlocked.chip);
if (await page.locator('#dlg[open]').count()) await page.locator('#dlgFoot button').last().click();
await page.waitForTimeout(200);

// 讀得到文字時要自動偵測
await page.setInputFiles('#fileDrawing', join(FIX, 'fixture-nts.pdf'));
await page.waitForFunction(() => window.__takeoff.state.pdfScale !== null, null, { timeout: 30000 });
await page.waitForTimeout(700);
if (await page.locator('#dlg[open]').count()) await page.locator('#dlgFoot button').last().click();
await page.waitForTimeout(200);
const auto = await page.evaluate(() => ({
  nts: window.__takeoff.state.pdfScale.nts,
  notToScale: window.__takeoff.state.viewer.notToScale,
  chip: document.querySelector('#scaleChip').textContent,
}));
ok('圖框文字寫 NO SCALE → 自動鎖住量測', auto.nts === true && auto.notToScale === true, JSON.stringify(auto));
await page.evaluate(() => window.__takeoff.state.viewer.setNotToScale(false));
await page.waitForTimeout(200);

console.log('\n【6之二】PDF 圖框比例與多重比例');
await page.locator('#tabView').click();
await page.setInputFiles('#fileDrawing', join(FIX, 'fixture-titleblock.pdf'));
await page.waitForFunction(() => window.__takeoff.state.pdfScale !== null, null, { timeout: 30000 });
await page.waitForTimeout(700);
const fr = await page.evaluate(() => {
  const f = window.__takeoff.state.pdfScale;
  return { paper: f.paper && f.paper.name, slack: f.paper && f.paper.slack, exact: f.exact,
    ratio: f.ratio, usable: f.usable, reason: f.picked.reason,
    cands: f.collected.scales.map((x) => `${x.paper || '?'}:1:${x.ratio}`) };
});
ok('由頁面尺寸判定為 A1', fr.paper === 'A1' && fr.slack < 0.5, JSON.stringify(fr));
ok('讀出圖框的兩個比例宣告', fr.cands.length === 2, JSON.stringify(fr.cands));
ok('依實際紙張挑中 1:100 而非 1:200', fr.ratio === 100 && fr.reason === 'paper-match', JSON.stringify(fr));
ok('紙張精確吻合 → 判定 PDF 未被縮放', fr.exact === true && fr.usable === true, JSON.stringify(fr));

if (await page.locator('#dlg[open]').count()) await page.locator('#dlgFoot button').last().click();
await page.waitForTimeout(200);
await page.locator('#scaleChip').click();
await page.waitForSelector('#dlg[open]');
await page.waitForTimeout(300);
const scaleTxt = await page.locator('#dlgBody').innerText();
ok('比例對話框最前面就警告一張圖不只一個比例',
  scaleTxt.includes('一張施工圖通常不只一個比例') && scaleTxt.includes('大樣的量測會整批錯掉'), '');
ok('列出圖框比例的判定證據', scaleTxt.includes('精確吻合 A1') && scaleTxt.includes('A1圖:1:100') === false
  ? scaleTxt.includes('1:100') : true, '');
await page.locator('#dlgBody #btnFramed').click();
await page.waitForTimeout(300);
ok('可一鍵套用圖框比例到整頁',
  await page.evaluate(() => Math.abs(window.__takeoff.state.viewer.metersPerUnit - 0.0352778) < 1e-6));

// 這張圖的 SECTION A-A 是 1:10：同樣長度的線，整頁比例會錯十倍
const multi = await page.evaluate(() => {
  const v = window.__takeoff.state.viewer;
  const D = 170.0787;                       // 600mm @1:10 = 6000mm @1:100，紙上同樣長
  const A = { x: 2000, y: 1250 }, B = { x: 2000 + D, y: 1250 };   // SECTION A-A 的 600 尺寸線
  const P = { x: 400, y: 1250 }, Qd = { x: 400 + D, y: 1250 };     // 主視圖的 6000 尺寸線
  const before = v.engValue({ type: 'length', pts: [A, B] }).value;
  const half = D * 1.5, cx = (A.x + B.x) / 2, cy = 1250;
  const z = v.addScaleZone({ x0: cx - half, y0: cy - half, x1: cx + half, y1: cy + half },
    0.6 / D, { name: 'SECTION A-A', ratio: Math.round((0.6 / D) / (25.4 / 72 / 1000)) });
  return {
    before,
    zoned: v.engValue({ type: 'length', pts: [A, B] }).value,
    plan: v.engValue({ type: 'length', pts: [P, Qd] }).value,
    zoneRatio: z.ratio, zones: v.scaleInfo().zones.length,
  };
});
ok('整頁比例會把 600mm 的大樣量成 6M（錯十倍）', Math.abs(multi.before - 5.997) < 0.02, String(multi.before));
ok('建立 1:10 比例分區後量得 0.600 M', Math.abs(multi.zoned - 0.6) < 0.005, String(multi.zoned));
ok('分區比例判定為 1:10', multi.zoneRatio === 10, String(multi.zoneRatio));
ok('分區外的主視圖仍用整頁 1:100 量得 6.0 M', Math.abs(multi.plan - 5.997) < 0.02, String(multi.plan));
ok('分區數回報在 scaleInfo', multi.zones === 1, String(multi.zones));

console.log('\n【7之零】真實地籍圖暴露的座標與單位問題');
await page.locator('#tabView').click();
await page.setInputFiles('#fileDrawing', join(FIX, 'fixture-tm2.dxf'));
await page.waitForFunction(() => window.__takeoff.state.survey !== null, null, { timeout: 15000 });
await page.waitForTimeout(600);
await page.waitForSelector('#dlg[open]');
const svTxt = await page.locator('#dlgBody').innerText();
const svTitle = await page.locator('#dlgTitle').textContent();
ok('宣告單位對不上座標大小時主動擋下', /單位對不上座標大小/.test(svTitle), svTitle);
ok('辨識出 TWD97 TM2 座標系', svTxt.includes('TWD97 TM2'), '');
ok('算出內容實際跨距（公尺）', /217|220/.test(svTxt) && svTxt.includes('公尺'), '');
ok('把「照宣告會變成多小」直接算給人看', svTxt.includes('1,000 倍') && /0\.2\d+ 公尺/.test(svTxt), '');
ok('回報座標分成多群、排除了幾個離群點', svTxt.includes('離群點'), '');
ok('明說工具不會自動改單位', svTxt.includes('不會自動改單位'), '');

const svBefore = await page.evaluate(() => window.__takeoff.state.viewer.metersPerUnit);
ok('未確認前維持圖檔宣告的單位', svBefore === 0.001, String(svBefore));
await page.locator('#dlgBody [data-setunit]').first().click();
await page.waitForTimeout(400);
const svAfter = await page.evaluate(() => ({
  mpu: window.__takeoff.state.viewer.metersPerUnit,
  fixed: window.__takeoff.state.surveyFixed,
}));
ok('確認後才改成公尺', svAfter.mpu === 1, JSON.stringify(svAfter));
ok('單位修正留下可稽核紀錄', !!(svAfter.fixed && svAfter.fixed.from === '公厘'), JSON.stringify(svAfter.fixed));

// 全覽要看內容，不是全部實體 —— 否則縮到看不見
const fit = await page.evaluate(() => {
  const v = window.__takeoff.state.viewer;
  v.fit();
  const raw = Math.max(v.bounds.maxX - v.bounds.minX, v.bounds.maxY - v.bounds.minY);
  const used = v.contentBounds ? Math.max(v.contentBounds.maxX - v.contentBounds.minX, v.contentBounds.maxY - v.contentBounds.minY) : raw;
  return { raw, used, k: v.view.k };
});
ok('全覽以內容範圍為準，不被離群圖例撐爛', fit.used < fit.raw / 100, JSON.stringify(fit));
ok('縮放倍率合理（不會縮到看不見）', fit.k > 0.5, String(fit.k));

// 地號不得被當成算式
ok('地號 2-13、1006-2 不被誤判為算式', await page.evaluate(() => {
  const st = window.__takeoff.state;
  return st.calc === null || st.calc.verify.counts.rows === 0;
}));

if (await page.locator('#dlg[open]').count()) await page.locator('#dlgFoot button').last().click();
await page.waitForTimeout(250);

// 宣告正確的同一張圖不該被誤報
await page.setInputFiles('#fileDrawing', join(FIX, 'fixture-tm2-ok.dxf'));
await page.waitForFunction(() => window.__takeoff.state.survey && window.__takeoff.state.survey.declared.toM === 1, null, { timeout: 15000 });
await page.waitForTimeout(500);
ok('宣告正確時不誤報單位問題', await page.evaluate(() => window.__takeoff.state.survey.ok === true));
if (await page.locator('#dlg[open]').count()) await page.locator('#dlgFoot button').last().click();
await page.waitForTimeout(250);

console.log('\n【7之三】圖面計算式');
await page.locator('#tabView').click();
await page.setInputFiles('#fileDrawing', join(FIX, 'fixture-calcsheet.dxf'));
await page.waitForFunction(() => window.__takeoff.state.calc !== null, null, { timeout: 15000 });
await page.waitForSelector('#dlg[open]');
await page.waitForTimeout(300);
let csTxt = await page.locator('#dlgBody').innerText();
ok('載入 DXF 後自動偵測到計算式表', csTxt.includes('找到') && csTxt.includes('計算式'), '');
ok('回報缺 SHX 字型造成的中文亂碼', csTxt.includes('亂碼') && csTxt.includes('數字與運算子不受字型影響'), '');
ok('明說計算式與幾何量是兩條獨立來源', csTxt.includes('兩條獨立來源'), '');

const cs = await page.evaluate(() => {
  const v = window.__takeoff.state.calc.verify;
  const gt = window.__takeoff.CS.grandTotal(window.__takeoff.state.calc.sheet);
  return { rows: v.counts.rows, passed: v.counts.passed, bad: v.counts.bad, warn: v.counts.warn,
    total: gt && gt.stated, unit: gt && gt.unit, declared: v.declared.map((d) => d.stated) };
});
ok('真實計算式表 14 式全部重算相符', cs.rows === 14 && cs.passed === 14, JSON.stringify(cs));
ok('零誤報（大面積扣除法與階層合計都不算錯）', cs.bad === 0, JSON.stringify(cs));
ok('算出總計 1509.04 M2', Math.abs(cs.total - 1509.04) < 0.001 && cs.unit === 'M2', JSON.stringify(cs));
ok('圖上宣告值被辨識出來', cs.declared.some((d) => Math.abs(d - 1509.04) < 0.001), JSON.stringify(cs.declared));

await page.locator('#dlgFoot button.primary').click();   // 查看與套用
await page.waitForSelector('#dlg[open]');
await page.waitForTimeout(300);
csTxt = await page.locator('#dlgBody').innerText();
ok('逐式驗算表列出重算值與圖上值', csTxt.includes('逐式驗算') && csTxt.includes('24.565*20.80'), '');
// 這份表被裁掉了 ⓐ 列，所以會有兩個警告 —— 那是正確的發現，不是誤報
ok('如實列出問題清單（被裁掉的 ⓐ 造成 2 個警告，0 個錯誤）',
  csTxt.includes('問題（2）') && csTxt.includes('參照不存在') && csTxt.includes('合計有孤項'),
  csTxt.slice(csTxt.indexOf('問題'), csTxt.indexOf('問題') + 160).replace(/\n/g, ' / '));
ok('計算式晶片顯示在工具列', await page.locator('#calcChip').isVisible());

// 套用到工項：單位相符
await page.selectOption('#calcPick', { index: 0 });
await page.selectOption('#calcItem', '230.01');           // 抛光石英磚，單位 M2
await page.locator('#dlgFoot button.primary').click();
await page.waitForTimeout(400);
const applied = await page.evaluate(() => {
  const it = window.__takeoff.state.itemByCode.get('230.01');
  return { calc: it.qty.calc, src: it.calcSource };
});
ok('計算式量寫入工項的第五條來源', Math.abs(applied.calc - 1509.04) < 0.001, JSON.stringify(applied));
ok('保留計算式出處可稽核', /=1509.04/.test(applied.src || ''), applied.src);
if (await page.locator('#dlg[open]').count()) await page.locator('#dlgFoot button').last().click();
await page.waitForTimeout(200);

// 單位不一致必須擋下來
await page.locator('#calcChip').click();
await page.waitForSelector('#dlg[open]');
await page.waitForTimeout(250);
await page.selectOption('#calcPick', { index: 0 });
await page.selectOption('#calcItem', '321.01');           // 電纜，單位 M
await page.locator('#dlgFoot button.primary').click();
await page.waitForTimeout(400);
const blocked = await page.evaluate(() => ({
  title: document.querySelector('#dlgTitle').textContent,
  txt: document.querySelector('#dlgBody').innerText,
  calc: window.__takeoff.state.itemByCode.get('321.01').qty.calc ?? null,
}));
ok('跨維度不自動換算，改問工程要寬度',
  /需要寬度/.test(blocked.title) && /面積除以寬度才是長度/.test(blocked.txt) && blocked.calc === null,
  JSON.stringify(blocked).slice(0, 200));
// 補上寬度後才換算，而且出處要記下這個數字
await page.fill('#bridgeVal', '0.5');
await page.locator('#dlgFoot button.primary').click();
await page.waitForTimeout(400);
const bridged = await page.evaluate(() => {
  const it = window.__takeoff.state.itemByCode.get('321.01');
  return { calc: it.qty.calc, src: it.calcSource };
});
ok('補上寬度 0.5M 後：1509.04 M2 ÷ 0.5 = 3018.08 M',
  Math.abs(bridged.calc - 3018.08) < 0.01, JSON.stringify(bridged).slice(0, 160));
ok('換算方式寫進數量出處，可稽核', /除以寬度 0\.5/.test(bridged.src || ''), bridged.src);
if (await page.locator('#dlg[open]').count()) await page.locator('#dlgFoot button').last().click();
await page.waitForTimeout(200);

// 同維度自動換算：坪 → M2
ok('同維度自動換算（坪 → M2，係數 3.3057851）', await page.evaluate(() => {
  const r = window.__takeoff.U.convert(456.5, '坪', 'M2');
  return r.ok && Math.abs(r.value - 1509.09) < 0.02;
}));
ok('計數單位不與面積互換（一片磚幾 M² 是規格問題）', await page.evaluate(() => {
  const r = window.__takeoff.U.convert(10, 'M2', '樘');
  return !r.ok && r.reason === 'count';
}));
if (await page.locator('#dlg[open]').count()) await page.locator('#dlgFoot button').last().click();
await page.waitForTimeout(200);

// 算式求值不得使用 eval
ok('算式求值拒絕任何非算術字元', await page.evaluate(() => {
  const CS = window.__takeoff.CS;
  return ['constructor', 'process.exit(1)', '1;alert(1)', 'globalThis'].every((e) => !!CS.evaluate(e).error);
}));

console.log('\n【7之二】原料行情連動');
await page.locator('#tabList').click();
await page.evaluate(() => {
  const st = window.__takeoff.state;
  st.selected = new Set(['321.01', '140.01', '410.01', '810.01', '610.01']);
  window.__takeoff.renderAll();
});
await page.waitForTimeout(250);
const susQty = await page.evaluate(() => {
  const { state, Q } = window.__takeoff;
  return ['410.01', '460.01', '810.01'].map((c) => {
    const it = state.itemByCode.get(c);
    const p = Q.suggestPurchase(it, state.settings);
    return { code: c, qty: p.suggestQty, status: p.status || Q.resolveBasis(it, state.settings).status };
  });
});
ok('410.01 因差異超標被鎖定、810.01 可用 —— 兩種情形都要被看見',
  susQty[0].qty == null && susQty[2].qty > 0, JSON.stringify(susQty));
ok('行情已載入（API 失敗時退回種子檔）', await page.evaluate(() => !!window.__takeoff.state.market));

await page.locator('#btnMarket').click();
await page.waitForSelector('#dlg[open]');
await page.waitForTimeout(300);
let mkTxt = await page.locator('#dlgBody').innerText();
ok('明說只有匯率是真正自動抓的', mkTxt.includes('只有匯率是真正自動抓的'), '');
ok('未設基準日時明說調整額為 0', mkTxt.includes('尚未設定價格基準日'), '');
ok('指數一律換算為台幣／公斤', mkTxt.includes('台幣／公斤'));
ok('不鏽鋼標示為無指數而非硬接鋼價', mkTxt.includes('無指數'));

// 凍結價格基準日
await page.locator('#dlgFoot button.primary').click();
await page.waitForTimeout(300);
if (await page.locator('#dlg[open]').count()) await page.locator('#dlgFoot button').last().click();
await page.waitForTimeout(200);
ok('可凍結價格基準日', await page.evaluate(() => !!window.__takeoff.state.priceBase));

// 模擬銅漲 20% + 台幣貶 5%，驗證複合而非相加
const linked = await page.evaluate(() => {
  const { state, PR, renderAll } = window.__takeoff;
  const m = state.market;
  m.items.find((x) => x.id === 'copper').price *= 1.2;
  m.items.find((x) => x.id === 'fx').price *= 1.05;
  renderAll();
  const snap = PR.snapshotIndices(m);
  const it = { ...state.itemByCode.get('321.01'), priceBase: state.priceBase };
  const lp = PR.linkedPrice(it, snap);
  const sus = { ...state.itemByCode.get('410.01'), priceBase: state.priceBase };
  return {
    idxRatio: PR.indexAt(snap, 'copper') / PR.indexAt(state.priceBase, 'copper'),
    share: lp.parts[0] && lp.parts[0].share,
    deltaPct: lp.deltaPct, price: lp.price, base: lp.basePrice,
    susLinked: PR.linkedPrice(sus, snap).linked,
  };
});
ok('美元指數乘匯率：銅 +20% × 台幣貶 5% = +26%', Math.abs(linked.idxRatio - 1.26) < 1e-9, String(linked.idxRatio));
ok('單價漲幅 = 原料佔比 × 指數漲幅，不等於指數漲幅',
  Math.abs(linked.deltaPct - linked.share * 26) < 1e-6 && linked.deltaPct < 26,
  `${linked.deltaPct.toFixed(2)}% vs 指數 26%`);
ok('連動後單價高於基準單價', linked.price > linked.base, `${linked.base} → ${linked.price.toFixed(2)}`);
ok('不鏽鋼不參與連動（行情表無鎳指數）', linked.susLinked === false);

await page.locator('#btnMarket').click();
await page.waitForSelector('#dlg[open]');
await page.waitForTimeout(300);
mkTxt = await page.locator('#dlgBody').innerText();
ok('設基準日後顯示基準 vs 現值', mkTxt.includes('價格基準日') && !mkTxt.includes('尚未設定價格基準日'));
ok('列出原料曝險分布', mkTxt.includes('原料曝險分布'));
ok('單獨列出量不出來的曝險（不鏽鋼無鎳指數）', mkTxt.includes('量不出來'),
  mkTxt.slice(mkTxt.indexOf('原料曝險分布'), mkTxt.indexOf('原料曝險分布') + 200).replace(/\n/g, ' / '));
ok('尚未定量的工項不會從曝險表悄悄消失',
  mkTxt.includes('曝險未計入下方統計') && mkTxt.includes('還沒量到'),
  mkTxt.includes('曝險未計入') ? '' : '被鎖定的 410.01 應該要被列出來');
ok('敏感度標明是情境不是預測', mkTxt.includes('情境，不是預測') && mkTxt.includes('沒有人知道銅價下個月往哪走'));
ok('列出鎖價窗口（接工序反推的發包日）', mkTxt.includes('鎖價窗口'), '');
const bar = await page.locator('#dlgBody .gbar i').count();
ok('曝險分布有分段圖', bar >= 3, String(bar));
await page.locator('#dlgFoot button').last().click();
await page.waitForTimeout(200);

ok('摘要列顯示原料連動金額', (await page.locator('#totals').innerText()).includes('其中原料連動'), '');

const expo = await page.evaluate(() => {
  const { state, PR, Q } = window.__takeoff;
  const snap = PR.snapshotIndices(state.market);
  const rows = [...state.selected].map((c) => {
    const it = { ...state.itemByCode.get(c), priceBase: state.priceBase };
    return PR.exposure(it, 100, snap);
  });
  const p = PR.portfolioExposure(rows);
  return { amount: p.amount, exposed: p.exposed, fixed: p.fixed, uncovered: p.uncovered, n: p.uncoveredRows.length };
});
ok('曝險 + 固定 + 量不出來 = 總額',
  Math.abs(expo.exposed + expo.fixed + expo.uncovered - expo.amount) < 0.01, JSON.stringify(expo));
ok('不鏽鋼金額列入「量不出來」而非「固定」', expo.uncovered > 0 && expo.n >= 1, JSON.stringify(expo));

console.log('\n【7之四】匯出 Excel');
// 這一節的起因：使用者按了匯出，畫面跳出「此物品不提供文件下載」。
// 有兩件事同時是壞的 ——
//   (1) 匯出的是 CSV，繁中 Windows 的 Excel 會用 Big5 猜 UTF-8，中文變亂碼；
//   (2) 對話框框架在按鈕的 fn() 跑完後無條件 close()，
//       fn() 若自己開了新對話框，就會被緊接著關掉 —— 按了完全沒反應。
await page.locator('#tabList').click();
await page.waitForTimeout(150);
await page.evaluate(() => { window.__takeoff.state.selected = new Set(); window.__takeoff.renderAll(); });
await page.locator('#btnExport').click();
await page.waitForSelector('#dlg[open]');
const allDl = page.waitForEvent('download');
await page.locator('#eAll').click();
await page.waitForTimeout(400);
ok('匯出後對話框仍然開著（不會按了沒反應）', await page.locator('#dlg[open]').count() === 1);
ok('對話框提供下載按鈕', await page.locator('#xDl').isVisible());
const allXl = readXlsx(await readFile(await (await allDl).path()));
ok('全部工項都在活頁簿裡',
  allXl.sheets[0].rows.length - 1 === await page.evaluate(() => window.__takeoff.state.items.length),
  `${allXl.sheets[0].rows.length - 1} 列`);
ok('工作表名稱是中文且未被截斷', allXl.sheets[0].name === '工程量清單', allXl.sheets[0].name);

// 不能下載時的後備：TSV 貼上。這條路不需要任何下載權限。
const tsv = await page.evaluate(() => document.querySelector('#xTsv')?.value || '');
ok('提供可貼進 Excel 的 TSV 後備', tsv.length > 100, `${tsv.length} 字元`);
const tsvHead = tsv.split('\n')[0].split('\t');
ok('TSV 欄數與活頁簿一致', tsvHead.length === allXl.sheets[0].rows[0].length,
  `TSV ${tsvHead.length} / XLSX ${allXl.sheets[0].rows[0].length}`);
ok('TSV 中文未亂碼', tsv.includes('低壓電力電纜'));
await closeDialog(page);

// 空選取要明講，不可以默默產出一個零列的檔
await page.locator('#btnExport').click();
await page.waitForSelector('#dlg[open]');
await page.locator('#eSel').click();
await page.waitForTimeout(300);
ok('沒有選任何工項時明說沒有資料',
  (await page.locator('#dlgTitle').innerText()).includes('沒有資料'),
  await page.locator('#dlgTitle').innerText());
await closeDialog(page);

// 所有採購包 = 一個活頁簿、一包一張工作表。
// 不是一包下載一個檔：瀏覽器對連續多次下載本來就會擋，而且採購要的是一次核對得完。
const pkgCountBefore = await page.evaluate(() => window.__takeoff.state.packages.length);
ok('此時有多個採購包（否則這一段驗不到多工作表）', pkgCountBefore > 1, String(pkgCountBefore));
const pkgDl = page.waitForEvent('download');
await page.locator('#btnExport').click();
await page.waitForSelector('#dlg[open]');
await page.locator('#ePkg').click();
const pkgXl = readXlsx(await readFile(await (await pkgDl).path()));
const pkgCount = await page.evaluate(() => window.__takeoff.state.packages.length);
ok('所有採購包匯成一個活頁簿、一包一張工作表', pkgXl.sheets.length === pkgCount,
  `${pkgXl.sheets.length} 張 / ${pkgCount} 包`);
ok('工作表名稱不重複（重複會讓活頁簿打不開）',
  new Set(pkgXl.sheets.map((x) => x.name)).size === pkgXl.sheets.length,
  pkgXl.sheets.map((x) => x.name).join('|'));
ok('每張詢價單都帶採購包抬頭', pkgXl.sheets.every((x) => x.rows[0][0] === '採購包'),
  JSON.stringify(pkgXl.sheets.map((x) => x.rows[0])));
ok('多張工作表時不提供 TSV（貼上只會貼到一張）',
  await page.locator('#xTsv').count() === 0);
await closeDialog(page);

console.log('\n【7之五】換圖與清除');
// 起因：使用者問「這畫面好像沒有清除鍵，若我要更新圖面，無法更新」。
// 實測下來問題比「不能更新」更糟 —— 能更新，但更新得不乾淨，而且不乾淨的地方都不講：
// 舊圖的量測還掛在新圖上（座標是舊圖的，會用新圖的比例換算出一個看起來正常的假數字），
// 舊圖寫進清單的圖面量也還在，出處欄還寫著舊檔名。
await page.locator('#tabView').click();
await page.waitForTimeout(200);
await closeDialog(page);

// 第一張圖 + 一筆量測 + 兩筆圖面量
await page.locator('#btnImportDrawing').click();
await page.locator('#fileDrawing').setInputFiles(join(FIX, 'fixture-calcsheet.dxf'));
await page.waitForTimeout(1500);
await closeDialog(page, 6);
await page.evaluate(() => {
  const { state } = window.__takeoff;
  state.viewer.measurements.push({ id: 'M-A', type: 'length', pts: [{ x: 0, y: 0 }, { x: 100, y: 0 }], itemCode: null });
  for (const c of ['321.02', '323.01']) {
    const it = state.itemByCode.get(c);
    it.qty.drawing = 946;
    it.provenance = { kind: 'dxf-layer', drawing: state.drawing.name, layer: 'L1', at: '' };
  }
});
const key1 = await page.evaluate(() => window.__takeoff.state.measureKey);
ok('量測依「哪張圖的哪一頁」歸屬', /fixture-calcsheet\.dxf@.+#1$/.test(key1), key1);

// 換成別張圖
await page.locator('#btnImportDrawing').click();
await page.locator('#fileDrawing').setInputFiles(join(FIX, 'fixture-tm2-ok.dxf'));
await page.waitForTimeout(1500);
await closeDialog(page, 6);
const sw = await page.evaluate(() => {
  const { state } = window.__takeoff;
  return { meas: state.viewer.measurements.length, nts: state.viewer.notToScale,
    calcChip: !document.querySelector('#calcChip').hidden,
    stale: !!state.itemByCode.get('321.02').drawingStale };
});
ok('換圖後舊圖的量測不會留在新圖上', sw.meas === 0, `還有 ${sw.meas} 筆`);
ok('換到別張圖不會誤判既有圖面量過期', sw.stale === false,
  '一個案子本來就有電氣圖／給排水圖好幾張，誤報會讓人學會忽略警告');

// 切回第一張 —— 量測是收起來，不是刪掉
await page.locator('#btnImportDrawing').click();
await page.locator('#fileDrawing').setInputFiles(join(FIX, 'fixture-calcsheet.dxf'));
await page.waitForTimeout(1500);
await closeDialog(page, 6);
const back = await page.evaluate(() => window.__takeoff.state.viewer.measurements.map((m) => m.id));
ok('切回同一張圖，量測會回來（收起來，不是刪掉）', back.join() === 'M-A', back.join() || '(空)');

// 同名不同內容 = 圖改版
const revised = Buffer.concat([await readFile(join(FIX, 'fixture-calcsheet.dxf')), Buffer.from('\n999\nREV-B\n')]);
await page.locator('#btnImportDrawing').click();
await page.locator('#fileDrawing').setInputFiles({ name: 'fixture-calcsheet.dxf', mimeType: 'image/vnd.dxf', buffer: revised });
await page.waitForTimeout(1800);
let revTitle = '';
for (let i = 0; i < 6; i++) {
  if (!(await page.locator('#dlg[open]').count())) break;
  revTitle = await page.locator('#dlgTitle').innerText();
  if (revTitle.includes('改版')) break;
  await page.locator('#dlgFoot button').first().click();
  await page.waitForTimeout(200);
}
ok('同名不同內容會判定為圖改版並主動說明', revTitle.includes('改版'), revTitle);
ok('改版對話框列出受影響的工項', (await page.locator('#dlgBody').innerText()).includes('321.02'));
await closeDialog(page, 6);
const rev = await page.evaluate(() => {
  const { state } = window.__takeoff;
  const it = state.itemByCode.get('321.02');
  return { stale: !!it.drawingStale, qty: it.qty.drawing, note: state.itemByCode.get('321.02').provenance?.drawing };
});
ok('舊版圖算出來的圖面量被標成「舊版」', rev.stale === true);
ok('標成舊版不等於自動刪除（可能已進基準版、已發包）', rev.qty === 946, String(rev.qty));
await page.locator('#tabList').click();
await page.waitForTimeout(250);
ok('清單上看得到「舊版」標記', (await page.locator('tr[data-code="321.02"]').innerText()).includes('舊版'));

// 清除是分層的，不是一顆核彈
await page.locator('#tabView').click();
await page.waitForTimeout(200);
await page.locator('#btnDrawReset').click();
await page.waitForSelector('#dlg[open]');
const resetTxt = await page.locator('#dlgBody').innerText();
ok('清除對話框標明每一項會影響幾筆', /清除 \d+ 筆/.test(resetTxt), resetTxt.slice(0, 90));
ok('清除對話框明說不會動到其他來源', resetTxt.includes('BOQ 量') && resetTxt.includes('基準版'));
await page.locator('#drClearStale').click();
await page.waitForTimeout(500);
const cleared = await page.evaluate(() => {
  const it = window.__takeoff.state.itemByCode.get('321.02');
  return { draw: it.qty.drawing, boq: it.qty.boq, prov: it.provenance, stale: !!it.drawingStale };
});
ok('清除舊版圖面量只清圖面量', cleared.draw == null && cleared.prov == null);
ok('BOQ 量不受清除影響', cleared.boq != null, String(cleared.boq));
await closeDialog(page, 6);

// 卸載
await page.locator('#btnDrawReset').click();
await page.waitForTimeout(250);
await page.locator('#drUnload').click();
await page.waitForTimeout(400);
ok('卸載後回到未載入狀態', (await page.locator('#drawName').innerText()).includes('未載入'));
ok('卸載後計算式晶片一起收掉', await page.locator('#calcChip').isHidden());
await closeDialog(page, 6);

console.log('\n【7之六】換圖時自動清除圖面量');
// 使用者要的：「BOM清單可以在下個圖面時自動清除嗎？」
// 可以，但要有護欄：已經凍結進基準版或已開請購單的工項不能被自動清掉，
// 否則已經發出去的文件會在沒人知道的情況下跟清單對不起來。
await page.locator('#tabView').click();
await page.waitForTimeout(200);
await closeDialog(page, 6);
// 這一段會動到工項數量、採購包與基準版，結束前要原樣還回去，
// 否則後面的「重整後狀態保留」會拿被污染的狀態去比對。
const snapBefore = await page.evaluate(() => {
  const { state } = window.__takeoff;
  return {
    qty: Object.fromEntries(['321.01', '321.02', '323.01']
      .map((c) => [c, JSON.parse(JSON.stringify({ q: state.itemByCode.get(c).qty,
        p: state.itemByCode.get(c).provenance || null }))])),
    pkgs: state.packages.length, bls: state.baselines.length,
  };
});
await page.evaluate(() => { window.__takeoff.state.settings.clearOnDrawingChange = 'prev'; });
await page.locator('#btnImportDrawing').click();
await page.locator('#fileDrawing').setInputFiles(join(FIX, 'fixture-calcsheet.dxf'));
await page.waitForTimeout(1500);
await closeDialog(page, 6);
const lockRes = await page.evaluate(() => {
  const { state, B } = window.__takeoff;
  for (const c of ['321.01', '321.02', '323.01']) {
    const it = state.itemByCode.get(c);
    it.qty.drawing = 500;
    it.provenance = { kind: 'dxf-layer', drawing: state.drawing.name, layer: 'L', at: '' };
  }
  // 用真的凍結流程把 321.01 鎖進基準版
  const pkg = { code: 'PKG-LOCK', name: '鎖定測試包', itemCodes: ['321.01'], vendor: '', needDate: '' };
  state.packages.push(pkg);
  const r = B.freezeBaseline(pkg, [state.itemByCode.get('321.01')], state.settings,
    { confirmedBy: '測試工程師', by: '測試工程師', note: 'e2e' });
  if (r.error) return { error: r.error };
  state.baselines.push(r.baseline);
  window.__takeoff.renderAll();
  return { locked: r.baseline.items.map((x) => x.code) };
});
ok('已把 321.01 凍結進基準版', !lockRes.error && lockRes.locked.includes('321.01'), JSON.stringify(lockRes));

await page.locator('#btnImportDrawing').click();
await page.locator('#fileDrawing').setInputFiles(join(FIX, 'fixture-tm2-ok.dxf'));
await page.waitForTimeout(1500);
let clearTitle = '';
for (let i = 0; i < 6; i++) {
  if (!(await page.locator('#dlg[open]').count())) break;
  clearTitle = await page.locator('#dlgTitle').innerText();
  if (clearTitle.includes('自動清除')) break;
  await page.locator('#dlgFoot button').first().click();
  await page.waitForTimeout(200);
}
ok('換圖時自動清除，而且會講一聲（自動歸自動，不可無聲無息）', clearTitle.includes('自動清除'), clearTitle);
const clearBody = await page.locator('#dlgBody').innerText();
ok('說明保留了幾筆與為什麼', clearBody.includes('基準版') && clearBody.includes('請購單'), clearBody.slice(0, 120));
await closeDialog(page, 6);
const afterClear = await page.evaluate(() => {
  const g = (c) => window.__takeoff.state.itemByCode.get(c);
  return { locked: g('321.01').qty.drawing, a: g('321.02').qty.drawing, b: g('323.01').qty.drawing,
    boq: g('321.02').qty.boq, prov: g('321.02').provenance };
});
ok('未承諾的圖面量被清掉', afterClear.a == null && afterClear.b == null, JSON.stringify(afterClear));
ok('已凍結進基準版的不會被自動清掉', afterClear.locked === 500, String(afterClear.locked));
ok('BOQ 量不受影響', afterClear.boq != null, String(afterClear.boq));
ok('出處一併清除，不留孤兒', afterClear.prov == null);

// 關掉之後不該再清
await page.evaluate(() => { window.__takeoff.state.settings.clearOnDrawingChange = 'keep'; });
await page.evaluate(() => {
  const it = window.__takeoff.state.itemByCode.get('323.01');
  it.qty.drawing = 777;
  it.provenance = { kind: 'dxf-layer', drawing: window.__takeoff.state.drawing.name, layer: 'L', at: '' };
});
await page.locator('#btnImportDrawing').click();
await page.locator('#fileDrawing').setInputFiles(join(FIX, 'fixture-calcsheet.dxf'));
await page.waitForTimeout(1500);
await closeDialog(page, 6);
ok('設為「保留」時換圖不會清（預設就是這個）',
  await page.evaluate(() => window.__takeoff.state.itemByCode.get('323.01').qty.drawing) === 777);

// 還原這一段動過的東西
await page.evaluate((b) => {
  const { state } = window.__takeoff;
  for (const [code, v] of Object.entries(b.qty)) {
    const it = state.itemByCode.get(code);
    it.qty = v.q;
    it.provenance = v.p;
    it.drawingStale = false;
  }
  state.packages.length = b.pkgs;
  state.baselines.length = b.bls;
  window.__takeoff.renderAll();
}, snapBefore);
ok('測試自己造的採購包與基準版已還原', await page.evaluate((b) => {
  const { state } = window.__takeoff;
  return state.packages.length === b.pkgs && state.baselines.length === b.bls
    && state.itemByCode.get('321.01').qty.drawing === b.qty['321.01'].q.drawing;
}, snapBefore));

console.log('\n【7之七】重複描繪偵測');
// 使用者指定：「得先做重複線段偵測，那比任何自動化都優先。」
// 理由是它靜默地把數量翻倍 —— 對應猜錯了數字會不合理而被發現，
// 重複描繪不會，它給你一個完全合理、但是錯一倍的數字。
// fixture-dupe.dxf 的每一個數字都是手算得出來的，見 tests/make-dupe-dxf.mjs。
await page.locator('#tabView').click();
await page.waitForTimeout(200);
await closeDialog(page, 6);
await page.locator('#btnImportDrawing').click();
await page.locator('#fileDrawing').setInputFiles(join(FIX, 'fixture-dupe.dxf'));
await page.waitForTimeout(1500);

const dupe = await page.evaluate(() => {
  const d = window.__takeoff.state.dupe;
  const g = (l) => { const x = d.byLayer.get(l); return { dup: x.duplicated, ratio: x.ratio, ins: x.dupInserts,
    sev: window.__takeoff.DD.severity(x) }; };
  return { clean: d.clean, tray: g('E-TRAY'), lite: g('E-LIGHT-HB'), wire: g('E-WIRE'),
    totals: d.totals, tol: d.tol };
});
ok('容差換算成圖檔單位的 1mm', Math.abs(dupe.tol - 1) < 1e-9, String(dupe.tol));
ok('反向重合 + 部分重疊 = 12000（手算值）', dupe.tray.dup === 12000, String(dupe.tray.dup));
ok('灌水 40% 判定為擋下', dupe.tray.sev === 'bad' && Math.abs(dupe.tray.ratio - 0.4) < 1e-9, JSON.stringify(dupe.tray));
ok('同點同名圖塊多算 1 只', dupe.lite.ins === 1, JSON.stringify(dupe.lite));
ok('圖塊重疊一律擋下（計數多一個就是採購單多一個）', dupe.lite.sev === 'bad');
ok('首尾相接的乾淨圖層不誤報', dupe.wire.dup === 0 && dupe.wire.sev === 'ok', JSON.stringify(dupe.wire));
ok('整張圖判為不乾淨', dupe.clean === false);

// 工具列晶片
ok('工具列出現重複描繪晶片', await page.locator('#dupChip').isVisible());
const chipTxt = await page.locator('#dupChip').innerText();
ok('晶片直接寫出重複多少公尺', chipTxt.includes('12.1') || chipTxt.includes('12.'), chipTxt);

// 圖層對映對話框：被擋下的列要停用
await closeDialog(page, 6);
await page.locator('#btnLayers').click();
await page.waitForSelector('#dlg[open]');
const rowState = await page.evaluate(() => {
  const out = {};
  for (const sel of document.querySelectorAll('#dlgBody [data-map]')) {
    out[sel.parentElement.querySelector('.lname').textContent] = sel.disabled;
  }
  return out;
});
ok('重複描繪的圖層下拉被停用', rowState['E-TRAY'] === true && rowState['E-LIGHT-HB'] === true, JSON.stringify(rowState));
ok('乾淨的圖層不受影響', rowState['E-WIRE'] === false, JSON.stringify(rowState));
const layTxt = await page.locator('#dlgBody').innerText();
ok('對話框說明被擋下的原因與處置', layTxt.includes('重複描繪') && layTxt.includes('OVERKILL'), layTxt.slice(0, 160));

// 套用 → 漏項清單要列出被擋下的圖層
await page.locator('#dlgFoot button.primary').click();
await page.waitForTimeout(400);
const rep = await page.locator('#dlgBody').innerText();
ok('漏項清單列出因重複描繪被擋下的圖層', rep.includes('E-TRAY') && rep.includes('重複描繪'), rep.slice(0, 220));
await closeDialog(page, 6);

// 重複描繪細節視窗
await page.locator('#dupChip').click();
await page.waitForSelector('#dlg[open]');
const dupTxt = await page.locator('#dlgBody').innerText();
ok('細節視窗逐圖層攤開', dupTxt.includes('E-TRAY') && dupTxt.includes('40.0%'), dupTxt.slice(0, 220));
ok('說明「重複長度 = 總長 − 聯集長度」的定義', dupTxt.includes('聯集'), dupTxt.slice(0, 160));
await closeDialog(page, 6);

console.log('\n【7之八】投標價組成');
// 使用者問「承包價中有含風險價嗎」—— 答案是沒有。清單上的「預估金額」是
// 採購成本：未稅、無管理費、無利潤、無風險準備。這一段補上中間那三層。
// 參數是使用者自述的實際作法：管理費 10%、利潤 10%、規費佔合約價 1%、稅 5%。
await page.locator('#tabList').click();
await page.waitForTimeout(200);
await closeDialog(page, 6);
await page.evaluate(() => {
  const s = window.__takeoff.state;
  s.selected = new Set(s.items.map((i) => i.code));
  window.__takeoff.renderAll();
});

// 先用固定數字驗算術本身，不受清單金額波動影響
const math = await page.evaluate(() => {
  const { BD } = window.__takeoff;
  const r = BD.buildUp(1000000);
  return { preTax: r.preTax, tax: r.tax, total: r.total,
    oh: r.lines.find((x) => x.key === 'overhead'),
    pf: r.lines.find((x) => x.key === 'profit'),
    fee: r.lines.find((x) => x.key === 'fees') };
});
ok('管理費 10% 算在直接成本上（100 萬 → 10 萬）', math.oh.amount === 100000, String(math.oh.amount));
ok('利潤算在「成本＋管理費」上（110 萬 → 11 萬，不是 10 萬）',
  math.pf.amount === 110000 && math.pf.base === 1100000, JSON.stringify(math.pf));
ok('規費「佔合約價 1%」要用除的：121 萬 ÷ 0.99 = 1,222,222.22',
  Math.abs(math.preTax - 1222222.22) < 0.02, String(math.preTax));
ok('用乘的會少算 —— 規費應是 12,222 而非 12,100',
  math.fee.amount > 12100, String(math.fee.amount));
ok('規費 ÷ 標價 剛好等於費率（這是「佔標價」的定義）',
  Math.abs(math.fee.amount / math.preTax - 0.01) < 1e-6);
ok('總價 = 未稅 × 1.05', Math.abs(math.total - 1283333.33) < 0.02, String(math.total));

// 價格風險：只能有一個開關。
// 這一組是為了擋住我自己犯過的錯 —— 曾經同時存在 priceRiskOn 與 priceDist
// 兩個旗標，priceDist 一進 settings 就讓風險模擬繞過開關，分散效益變成負的。
const riskGate = await page.evaluate(() => {
  const { state, R } = window.__takeoff;
  const items = state.items.slice(0, 8);
  const off = R.simulatePortfolio(items, { ...state.settings, priceDist: null });
  const on = R.simulatePortfolio(items, { ...state.settings, priceDist: { min: -0.02, mode: 0, max: 0.08 } });
  return { offRisk: off && off.priceRisk, onRisk: !!(on && on.priceRisk),
    offP80: off && off.cost.p80, onP80: on && on.cost.p80,
    settingHas: Object.prototype.hasOwnProperty.call(state.settings, 'priceDist'),
    settingVal: state.settings.priceDist };
});
ok('價格風險預設關閉', riskGate.settingHas && riskGate.settingVal === null, JSON.stringify(riskGate.settingVal));
ok('關閉時模擬不帶價格風險', riskGate.offRisk === null);
ok('開啟時 P80 會變高（發包時報價比估價高）',
  riskGate.onRisk && riskGate.onP80 > riskGate.offP80, `${riskGate.onP80} vs ${riskGate.offP80}`);

// 視窗本身
await page.locator('#btnBid').click();
await page.waitForSelector('#dlg[open]');
await page.waitForTimeout(500);
const bidTxt = await page.locator('#dlgBody').innerText();
ok('視窗開得起來並標明「預估金額是採購成本不是承包價」',
  bidTxt.includes('採購成本') && bidTxt.includes('承包價'), bidTxt.slice(0, 120));
ok('逐層攤開並標出每一層的計算基數',
  bidTxt.includes('計算基數') && bidTxt.includes('工地管理費') && bidTxt.includes('利潤'), bidTxt.slice(0, 200));
ok('明講「佔標價」與「成本加成」是兩種數學', bidTxt.includes('必須用除的'));
ok('風險準備金由模擬推導並寫出依據', bidTxt.includes('P50'), bidTxt.slice(0, 400));
ok('價格風險關閉時明說準備金只涵蓋數量風險',
  bidTxt.includes('只涵蓋') && bidTxt.includes('數量'), bidTxt.slice(0, 500));
ok('逾期罰款以情境呈現（每日千分之一）', bidTxt.includes('逾期罰款') && bidTxt.includes('1.0‰'));
ok('算得出罰款吃光利潤要幾天', /延誤 \d+ 天，罰款就吃光全部利潤/.test(bidTxt), bidTxt.slice(-400));
ok('明說費率是公司的商業決定，工具不替你決定', bidTxt.includes('商業決定'));

// 匯出
const bidDl = page.waitForEvent('download');
await page.locator('#dlgFoot button').filter({ hasText: '匯出' }).click();
const bidXl = readXlsx(await readFile(await (await bidDl).path()));
ok('投標價組成可匯出 Excel', bidXl.sheets.some((s) => s.name.includes('投標價組成')),
  bidXl.sheets.map((s) => s.name).join('|'));
ok('匯出內含逐層金額與投標總價',
  bidXl.text.includes('投標總價') && bidXl.text.includes('工地管理費'), bidXl.text.slice(0, 200));
ok('匯出含延誤情境工作表', bidXl.sheets.some((s) => s.name.includes('延誤')));
await closeDialog(page, 6);

console.log('\n【7之十】驗算報告');
// 使用者問：「如何知道程式讀取圖面的尺寸、數量有沒有誤？程式可有驗算功能？」
// 最強的一條原本完全沒用到：DXF 的 DIMENSION 同時存了 CAD 自己量到的值（group 42）
// 與圖上印出來的字（group 1）。圖面自己帶著答案。
await page.locator('#tabView').click();
await page.waitForTimeout(200);
await closeDialog(page, 6);

// 標註與幾何一致的圖
await page.locator('#btnImportDrawing').click();
await page.locator('#fileDrawing').setInputFiles(join(FIX, 'fixture-dim-ok.dxf'));
await page.waitForTimeout(1500);
await closeDialog(page, 6);
const okDim = await page.evaluate(() => window.__takeoff.state.dims);
ok('讀到 DIMENSION 標註實體', okDim.total === 3, JSON.stringify(okDim && { t: okDim.total }));
ok('標註與幾何一致時判為 match', okDim.match === 3 && okDim.scale === 0 && okDim.override === 0,
  JSON.stringify({ m: okDim.match, s: okDim.scale, o: okDim.override }));
ok('不誤判成整張圖單位錯', okDim.dominant === null);

// 標註差 1000 倍 + 一個被覆寫的圖
await page.locator('#btnImportDrawing').click();
await page.locator('#fileDrawing').setInputFiles(join(FIX, 'fixture-dim-bad.dxf'));
await page.waitForTimeout(1500);
await closeDialog(page, 6);
const badDim = await page.evaluate(() => window.__takeoff.state.dims);
ok('抓到 4 個標註與幾何差 1000 倍', badDim.scale === 4 && badDim.dominant
  && badDim.dominant.magnitude === 1000, JSON.stringify({ s: badDim.scale, d: badDim.dominant }));
ok('把「差整數量級」判成單位／比例錯，而不是標註錯',
  badDim.rows.filter((r) => r.verdict === 'scale').length === 4);
ok('抓到 1 個標註文字被手動覆寫（幾何 0.56 卻印 600）',
  badDim.override === 1 && badDim.rows.some((r) => r.verdict === 'override' && r.stated === 600),
  JSON.stringify(badDim.rows.filter((r) => r.verdict === 'override')));
ok('每一筆都留座標與圖層，找得到是哪一個標註',
  badDim.rows.every((r) => r.at && r.layer), JSON.stringify(badDim.rows[0]));

// 工具列晶片
ok('工具列出現驗算晶片', await page.locator('#vfChip').isVisible());
ok('晶片直接寫出幾項不過', /驗算 \d+ 項不過/.test(await page.locator('#vfChip').innerText()),
  await page.locator('#vfChip').innerText());

// 報告視窗
await page.locator('#vfChip').click();
await page.waitForSelector('#dlg[open]');
await page.waitForTimeout(300);
const vfTxt = await page.locator('#dlgBody').innerText();
ok('報告列出八項檢查', (vfTxt.match(/通過|待確認|不通過|沒得驗/g) || []).length >= 8, vfTxt.slice(0, 200));
ok('明確區分「已驗過」與「沒得驗」', vfTxt.includes('沒得驗') && vfTxt.includes('「沒得驗」不是「沒有錯」'),
  vfTxt.slice(0, 600));
ok('整張圖差一個量級時，說明「每一個數量都錯 1000 倍」',
  vfTxt.includes('每一個數量都錯 1000 倍'), vfTxt.slice(-900));
ok('標註被覆寫時，說明人看文字、程式看幾何',
  vfTxt.includes('人看圖相信文字，程式量測相信幾何'), vfTxt.slice(-700));
ok('攤開逐筆比對（幾何量到 / 圖上印的 / 比值）',
  vfTxt.includes('幾何量到') && vfTxt.includes('圖上印的') && vfTxt.includes('比值'));
ok('說明資料來源是 group 42 與 group 1', vfTxt.includes('group 42') && vfTxt.includes('group 1'));

// 匯出
const vfDl = page.waitForEvent('download');
await page.locator('#dlgFoot button').filter({ hasText: '匯出' }).click();
const vfXl = readXlsx(await readFile(await (await vfDl).path()));
ok('驗算報告可匯出 Excel', vfXl.sheets.some((s) => s.name.includes('驗算摘要')),
  vfXl.sheets.map((s) => s.name).join('|'));
ok('匯出含標註逐筆比對', vfXl.sheets.some((s) => s.name.includes('標註比對')));
ok('匯出含多來源比對', vfXl.sheets.some((s) => s.name.includes('多來源')));
await closeDialog(page, 6);

// 從標題列也開得到
await page.locator('#btnVerify').click();
await page.waitForSelector('#dlg[open]');
ok('標題列的「驗算」按鈕開得起同一份報告',
  (await page.locator('#dlgTitle').innerText()).includes('驗算報告'));
await closeDialog(page, 6);

// 八項全無可驗時不可以說通過
const empty = await page.evaluate(() => window.__takeoff.VF.report({}));
ok('八項全是「沒得驗」時不算通過', empty.passed === false && empty.verdict === 'none', JSON.stringify(empty.note));
ok('並且明說「這不是沒有錯誤，是沒有檢查」', /沒有檢查/.test(empty.note), empty.note);

// 人工量測的面積不該被誤判未閉合（曾經的誤報）
const closure = await page.evaluate(() => {
  const { VF, state, Q } = window.__takeoff;
  return VF.checkClosure(state.items.filter((it) => Q.isNum(it.qty && it.qty.drawing)));
});
ok('人工量測的面積不會被誤判成未閉合', closure.length === 0, JSON.stringify(closure));

console.log('\n【8】重整後狀態保留');
const drawBefore = await page.evaluate(() => window.__takeoff.state.itemByCode.get('331.01').qty.drawing);
ok('（前置）331.01 確實有圖面量可供驗證持久化', typeof drawBefore === 'number', String(drawBefore));
await page.reload();
await page.waitForFunction(() => window.__takeoff && window.__takeoff.state.items.length > 0);
const after = await page.evaluate(() => ({
  baselines: window.__takeoff.state.baselines.length,
  prs: window.__takeoff.state.prs.length,
  tasks: window.__takeoff.state.tasks.length,
  pkgs: window.__takeoff.state.packages.length,
  manual: window.__takeoff.state.itemByCode.get('710.01').qty.manual,
  draw: window.__takeoff.state.itemByCode.get('331.01').qty.drawing,
}));
ok('採購包持久化', after.pkgs === pkgTotal, `重整後 ${after.pkgs} / 預期 ${pkgTotal}`);
ok('人工確認持久化', after.manual === 5600);
// 321.01 已不再是好樣本：E-CABLE-PWR 因無法分辨而被擋下，本來就不會有圖面量。
// 改用 331.01（由圖塊計數寫入 4 只）驗證圖面量確實存得住。
ok('圖面量持久化', after.draw === drawBefore, `重整後 ${after.draw} / 重整前 ${drawBefore}`);
ok('基準版與請購單持久化', after.baselines === 1 && after.prs === 1, JSON.stringify(after));
ok('價格基準日持久化', await page.evaluate(() => !!window.__takeoff.state.priceBase));
ok('工序持久化', after.tasks === 63, String(after.tasks));

console.log('\n【9】無 JS 例外');
ok('頁面無未捕捉錯誤', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.close();
console.log(`\n通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);


/**
 * 關掉目前開著的對話框。
 *
 * 匯出改成 .xlsx 之後，按下匯出不再是「下載完就結束」：對話框會留著，
 * 因為有些環境（例如把頁面嵌在別人框裡）會擋掉網頁自己發起的下載，
 * 那時候唯一能用的是對話框裡的「複製貼進 Excel」。測試要跟著把它關掉。
 */
async function closeDialog(pg, times = 3) {
  for (let i = 0; i < times; i++) {
    if (!(await pg.locator('#dlg[open]').count())) return;
    await pg.locator('#dlgFoot button').first().click();
    await pg.waitForTimeout(120);
  }
}

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
