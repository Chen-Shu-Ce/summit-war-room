/** 原料行情連動的回歸測試。重點在幣別、基準日、與「不硬接指數」這三件事。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as P from '../public/js/takeoff/pricing.js';

const mkt = (o = {}) => ({
  updatedAt: '2026-09-13T00:00:00Z',
  items: [
    { id: 'copper', price: o.copper ?? 13700, unit: 'US$ / 公噸', changePct: 0 },
    { id: 'aluminium', price: o.aluminium ?? 3400, unit: 'US$ / 公噸', changePct: 0 },
    { id: 'steel', price: o.steel ?? 19600, unit: 'NT$ / 公噸', changePct: 0 },
    { id: 'pp', price: o.pp ?? 1015, unit: 'US$ / 公噸', changePct: 0 },
    { id: 'fx', price: o.fx ?? 31.65, unit: '台幣 / 美元', changePct: 0 },
  ],
});

/* ── 幣別 ── */

test('美元報價的指數會乘匯率，台幣報價的不會', () => {
  const s = P.snapshotIndices(mkt());
  assert.equal(+P.indexAt(s, 'copper').toFixed(2), +(13700 * 31.65 / 1000).toFixed(2));
  assert.equal(P.indexAt(s, 'steel'), 19.6);                       // NT$ 報價，不乘匯率
  assert.equal(+P.indexAt(s, 'aluminium').toFixed(2), +(3400 * 31.65 / 1000).toFixed(2));
});

test('沒有匯率就算不出美元指數的台幣值，回 null 而不是用預設值蒙混', () => {
  const m = mkt();
  m.items = m.items.filter((x) => x.id !== 'fx');
  assert.equal(P.indexTwdPerKg(m, 'copper'), null);
  assert.equal(P.indexTwdPerKg(m, 'steel').twdPerKg, 19.6);        // 台幣報價不受影響
});

/* ── 基準日 ── */

test('沒有價格基準快照就不調整，並說明原因', () => {
  const it = { code: 'X', unitPrice: 780, priceLink: [{ index: 'copper', grade: 'direct', kg: 1.0214 }] };
  const r = P.linkedPrice(it, P.snapshotIndices(mkt()));
  assert.equal(r.linked, false);
  assert.equal(r.reason, 'no-base');
  assert.equal(r.price, 780);
  assert.equal(r.delta, 0);
  assert.match(P.LINK_REASON['no-base'], /不知道這個單價是在哪個行情水準報的/);
});

test('基準與現值相同時調整額為 0，但狀態是「已連動」而非「無基準」', () => {
  const base = P.snapshotIndices(mkt());
  const it = { code: 'X', unitPrice: 780, priceBase: base, priceLink: [{ index: 'copper', grade: 'direct', kg: 1.0214 }] };
  const r = P.linkedPrice(it, base);
  assert.equal(r.linked, true);
  assert.equal(+r.delta.toFixed(6), 0);
  assert.equal(r.reason, null);
});

/* ── 物價指數調整式 ── */

test('只有原料部分隨行情浮動，其餘固定（FIDIC 13.8 結構）', () => {
  const base = P.snapshotIndices(mkt());
  const it = { code: 'X', unitPrice: 780, priceBase: base, priceLink: [{ index: 'copper', grade: 'direct', kg: 1.0214 }] };
  const share = (1.0214 * P.indexAt(base, 'copper')) / 780;
  assert.ok(share > 0.55 && share < 0.58, `銅佔比 ${share}`);

  const now = P.snapshotIndices(mkt({ copper: 13700 * 1.1 }));      // 銅 +10%
  const r = P.linkedPrice(it, now);
  assert.equal(+r.deltaPct.toFixed(4), +(share * 10).toFixed(4));   // 漲幅 = 佔比 × 10%
  assert.ok(r.deltaPct < 10, '單價漲幅必須小於銅價漲幅 —— 單價不等於原料價');
  assert.equal(+r.fixedShare.toFixed(4), +(1 - share).toFixed(4));
});

test('銅漲 10% 且台幣貶 5%，台幣成本是複合而非相加', () => {
  const base = P.snapshotIndices(mkt());
  const it = { code: 'X', unitPrice: 1000, priceBase: base, priceLink: [{ index: 'copper', grade: 'direct', share: 1 }] };
  const now = P.snapshotIndices(mkt({ copper: 13700 * 1.1, fx: 31.65 * 1.05 }));
  const r = P.linkedPrice(it, now);
  const expect = (1.1 * 1.05 - 1) * 100;                            // 15.5%，不是 15%
  assert.equal(+r.deltaPct.toFixed(6), +expect.toFixed(6));
  assert.ok(Math.abs(r.deltaPct - 15) > 0.4, '相加會得到 15%，那是錯的');
});

test('多指數連動各自貢獻，可逐項攤開', () => {
  const base = P.snapshotIndices(mkt());
  const it = {
    code: 'CH', unitPrice: 4200000, priceBase: base,
    priceLink: [
      { index: 'copper', grade: 'estimate', kg: 1000 },
      { index: 'steel', grade: 'estimate', kg: 1500 },
    ],
  };
  const now = P.snapshotIndices(mkt({ copper: 13700 * 1.2, steel: 19600 * 0.9 }));
  const r = P.linkedPrice(it, now);
  assert.equal(r.parts.length, 2);
  const cu = r.parts.find((p) => p.index === 'copper');
  const st = r.parts.find((p) => p.index === 'steel');
  assert.ok(cu.contribAmt > 0 && st.contribAmt < 0, '銅漲鋼跌，方向要分開看得出來');
  assert.equal(+(cu.contribAmt + st.contribAmt).toFixed(4), +r.delta.toFixed(4));
});

/* ── 用量推導 vs 宣告佔比 ── */

test('用量可由導體規格推算，算不出就回 null 不猜', () => {
  assert.equal(P.copperKgPerM('600V 3C×38mm² CU/XLPE/PVC'), +(3 * 38 * 8.96 / 1000).toFixed(4));
  assert.equal(P.copperKgPerM('600V 1C×22mm² 綠色'), +(22 * 8.96 / 1000).toFixed(4));
  assert.equal(P.copperKgPerM('φ100 Sch40 黑鐵管'), null);
  assert.equal(P.copperKgPerM(''), null);
});

test('用量優先於宣告佔比，且回報是哪一種來源', () => {
  const base = P.snapshotIndices(mkt());
  const byKg = P.shareOf({ kg: 1.0214, share: 0.9 }, 780, P.indexAt(base, 'copper'));
  assert.equal(byKg.from, 'kg');
  assert.ok(Math.abs(byKg.share - 0.568) < 0.002);
  assert.equal(P.shareOf({ share: 0.9 }, 780, P.indexAt(base, 'copper')).from, 'share');
});

/* ── 檢核：擋的是資料錯誤，不是行情異常 ── */

test('佔比超過 100% 判定為資料錯誤（單價低於原料成本不可能）', () => {
  const snap = P.snapshotIndices(mkt());
  const it = { code: 'X', unitPrice: 100, priceLink: [{ index: 'copper', grade: 'direct', kg: 1 }] };
  const v = P.validateLink(it, snap);
  assert.equal(v.ok, false);
  assert.ok(v.errs.some((e) => e.level === 'bad' && /超過 100%/.test(e.msg)));
});

test('材料即產品時佔比過低 → 警告單價單位可能錯；組裝品佔比過低 → 預期內', () => {
  const snap = P.snapshotIndices(mkt());
  const wire = { code: 'W', unitPrice: 1900, priceLink: [{ index: 'copper', grade: 'direct', kg: 0.0493 }] };
  const vw = P.validateLink(wire, snap);
  assert.ok(vw.errs.some((e) => e.level === 'warn' && /單位很可能錯/.test(e.msg)));

  const panel = { code: 'P', unitPrice: 465000, priceLink: [{ index: 'steel', grade: 'estimate', kg: 250 }] };
  const vp = P.validateLink(panel, snap);
  assert.ok(vp.errs.every((e) => e.level === 'info'), '組裝品不該被當成資料錯誤');
  assert.equal(vp.ok, true);
});

test('標記為無指數是刻意判斷，不是錯誤，但必須被看見', () => {
  const snap = P.snapshotIndices(mkt());
  const sus = { code: 'S', name: '不鏽鋼給水管', unitPrice: 1180, priceLink: [{ index: 'steel', grade: 'none', note: 'SUS304 由鎳主導。' }] };
  const v = P.validateLink(sus, snap);
  assert.equal(v.ok, true, '不是錯誤');
  assert.ok(v.errs.some((e) => e.level === 'info' && /曝險仍然存在/.test(e.msg)), '但要明說曝險量不出來');
  assert.equal(P.linkedPrice(sus, snap).linked, false);
});

/* ── 曝險 ── */

test('無指數的金額不得併入「固定」—— 低估曝險比高估危險', () => {
  const snap = P.snapshotIndices(mkt());
  const cable = { code: 'C', name: '電纜', unitPrice: 780, priceBase: snap, priceLink: [{ index: 'copper', grade: 'direct', kg: 1.0214 }] };
  const sus = { code: 'S', name: '不鏽鋼管', unitPrice: 1180, priceBase: snap, priceLink: [{ index: 'steel', grade: 'none' }] };
  const rows = [P.exposure(cable, 1000, snap), P.exposure(sus, 500, snap)];
  const port = P.portfolioExposure(rows);

  assert.equal(+port.amount.toFixed(2), +(1000 * 780 + 500 * 1180).toFixed(2));
  assert.equal(+port.uncovered.toFixed(2), +(500 * 1180).toFixed(2));
  assert.equal(+(port.exposed + port.fixed + port.uncovered).toFixed(2), +port.amount.toFixed(2), '三者必須加總回總額');
  assert.ok(port.uncoveredRows.some((r) => r.code === 'S'));
});

test('敏感度是情境不是預測，各指數分開列', () => {
  const snap = P.snapshotIndices(mkt());
  const cable = { code: 'C', name: '電纜', unitPrice: 780, priceBase: snap, priceLink: [{ index: 'copper', grade: 'direct', kg: 1.0214 }] };
  const s = P.sensitivity([P.exposure(cable, 1000, snap)], [-0.1, 0.1]);
  assert.equal(s.length, 1);
  assert.equal(s[0].id, 'copper');
  assert.equal(+s[0].cells[1].delta.toFixed(4), +(s[0].exposure * 0.1).toFixed(4));
  assert.equal(+s[0].cells[0].delta.toFixed(4), -(+(s[0].exposure * 0.1).toFixed(4)));
});

/* ── 鎖價窗口（接工序反推） ── */

test('鎖價窗口以建議發包日為界', () => {
  assert.equal(P.lockWindow({ itemCode: 'X', poBy: '2026-10-13' }, '2026-09-13').days, 30);
  assert.equal(P.lockWindow({ itemCode: 'X', poBy: '2026-10-13' }, '2026-09-13').state, 'open');
  assert.equal(P.lockWindow({ itemCode: 'X', poBy: '2026-09-20' }, '2026-09-13').state, 'closing');
  assert.equal(P.lockWindow({ itemCode: 'X', poBy: '2026-08-13' }, '2026-09-13').state, 'passed');
  assert.equal(P.lockWindow(null, '2026-09-13'), null);
});

/* ── 建議（只是建議） ── */

test('不鏽鋼的建議是「不連動」，不是接到鋼指數', () => {
  const s = P.suggestLink({ name: '不鏽鋼給水管', spec: 'SUS304 φ50 Sch10' });
  assert.equal(s.links[0].grade, 'none');
  assert.match(s.why, /鎳/);
});

test('PVC 連 PP 指數會明說這是最弱的一條', () => {
  const s = P.suggestLink({ name: 'PVC 排水管', spec: 'A 級 φ100' });
  assert.equal(s.links[0].index, 'pp');
  assert.equal(s.links[0].grade, 'proxy');
  assert.match(s.why, /原料不同|弱相關/);
});

/* ── 範本資料 ── */

test('範本所有連動設定都通過檢核（無 bad、無 warn）', async () => {
  const wbs = JSON.parse(await readFile(new URL('../public/data/wbs-template.json', import.meta.url), 'utf8'));
  const seed = JSON.parse(await readFile(new URL('../public/data/market-seed.json', import.meta.url), 'utf8'));
  const snap = P.snapshotIndices(seed);
  const bad = [];
  for (const it of wbs.items) {
    if (!it.priceLink) continue;
    for (const e of P.validateLink(it, snap).errs) {
      if (e.level === 'bad' || e.level === 'warn') bad.push(`${it.code} ${it.name}：${e.msg}`);
    }
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

test('範本的銅佔比落在電纜業實務區間（50–60%）', async () => {
  const wbs = JSON.parse(await readFile(new URL('../public/data/wbs-template.json', import.meta.url), 'utf8'));
  const seed = JSON.parse(await readFile(new URL('../public/data/market-seed.json', import.meta.url), 'utf8'));
  const snap = P.snapshotIndices(seed);
  for (const code of ['321.01', '321.02', '350.01']) {
    const it = wbs.items.find((x) => x.code === code);
    const s = P.shareOf(it.priceLink[0], it.unitPrice, P.indexAt(snap, 'copper'));
    assert.ok(s.share > 0.45 && s.share < 0.65, `${code} 銅佔比 ${(s.share * 100).toFixed(1)}% 不在合理區間`);
  }
});

test('鋼筋是最乾淨的連動：用量為 1 kg/KG，佔比就是原料成本比', async () => {
  const wbs = JSON.parse(await readFile(new URL('../public/data/wbs-template.json', import.meta.url), 'utf8'));
  const seed = JSON.parse(await readFile(new URL('../public/data/market-seed.json', import.meta.url), 'utf8'));
  const snap = P.snapshotIndices(seed);
  const it = wbs.items.find((x) => x.code === '140.01');
  assert.equal(it.priceLink[0].kg, 1);
  assert.equal(it.priceLink[0].grade, 'direct');
  const s = P.shareOf(it.priceLink[0], it.unitPrice, P.indexAt(snap, 'steel'));
  assert.equal(+s.share.toFixed(4), +(19.6 / 24.5).toFixed(4));
});

test('曝險以現在的原料價值計算，不沿用基準日佔比（否則會低估）', () => {
  const base = P.snapshotIndices(mkt());
  const it = { code: 'C', name: '電纜', unitPrice: 780, priceBase: base,
    priceLink: [{ index: 'copper', grade: 'direct', kg: 1.0214 }] };

  const now = P.snapshotIndices(mkt({ copper: 13700 * 1.2 }));       // 銅 +20%
  const e = P.exposure(it, 1000, now);
  const lp = P.linkedPrice(it, now);

  // 現在的原料單價 = 1.0214 kg × 現在的銅價
  assert.equal(+e.exposed.toFixed(2), +(1000 * 1.0214 * P.indexAt(now, 'copper')).toFixed(2));

  const shareNow = e.exposed / e.amount;
  const shareBase = (1.0214 * P.indexAt(base, 'copper')) / 780;
  assert.ok(shareNow > shareBase + 0.02,
    `原料漲了佔比就該變大：基準 ${(shareBase * 100).toFixed(1)}% → 現在 ${(shareNow * 100).toFixed(1)}%`);
  assert.ok(shareNow < 1);
  assert.equal(+(e.exposed + e.fixed).toFixed(2), +e.amount.toFixed(2), '曝險加固定必須等於總額');
  assert.ok(lp.price > 780);
});

test('宣告佔比的連動，曝險同樣隨指數變動', () => {
  const base = P.snapshotIndices(mkt());
  const it = { code: 'P', name: '盤', unitPrice: 1000, priceBase: base,
    priceLink: [{ index: 'copper', grade: 'estimate', share: 0.2 }] };
  const flat = P.exposure(it, 1, base);
  assert.equal(+flat.exposed.toFixed(4), 200);
  const up = P.exposure(it, 1, P.snapshotIndices(mkt({ copper: 13700 * 1.5 })));
  assert.equal(+up.exposed.toFixed(4), 300);                          // 0.2 × 1000 × 1.5
});
