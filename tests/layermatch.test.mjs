/**
 * 圖層 → 工項自動對應的測試。
 *
 * 這個模組的價值不在「猜得準」，在「猜不準的時候會說出來」。
 * 所以測試的重點是那些**應該拒絕自動對應**的情形：
 * 兩個工項共用同一個關鍵字、分數不夠、幾何型態根本不對。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as LM from '../public/js/takeoff/layermatch.js';

/* 取自 public/data/wbs-template.json 的真實資料 —— 包含那個共用關鍵字的陷阱 */
const ITEMS = [
  { code: '321.01', name: '低壓電力電纜 XLPE', spec: '600V 3C×38mm² CU/XLPE/PVC CNS 11174',
    unit: 'M', measureType: 'length', layerHints: ['E-CABLE-PWR', 'E-PWR', '電纜'] },
  { code: '321.02', name: '低壓電力電纜 XLPE', spec: '600V 3C×22mm² CU/XLPE/PVC CNS 11174',
    unit: 'M', measureType: 'length', layerHints: ['E-CABLE-PWR'] },
  { code: '322.01', name: '絕緣電線 PVC', spec: '600V 1C×5.5mm² CNS 679',
    unit: 'M', measureType: 'length', layerHints: ['E-WIRE'] },
  { code: '323.01', name: '電纜架 (Cable Tray)', spec: '梯型 600W×100H 熱浸鍍鋅 t=2.0mm',
    unit: 'M', measureType: 'length', layerHints: ['E-TRAY'] },
  { code: '331.01', name: 'LED 高天井燈', spec: '150W 5000K IP65 CNS 15630',
    unit: '只', measureType: 'count', layerHints: ['E-LIGHT-HB'] },
  { code: '350.01', name: '接地線 PVC', spec: '600V 1C×22mm² 綠色',
    unit: 'M', measureType: 'length', layerHints: ['E-GND', '接地'] },
];

const LINES = { layer: 'X', length: 1200, area: 0, count: 40, closedCount: 0, openCount: 40, blocks: {}, types: {} };
const BLOCKS = { layer: 'X', length: 0, area: 0, count: 32, closedCount: 0, openCount: 0, blocks: { 'LED-HB': 32 }, types: {} };
const CLOSED = { layer: 'X', length: 300, area: 850, count: 6, closedCount: 6, openCount: 0, blocks: {}, types: {} };

const nameOf = (c) => (ITEMS.find((i) => i.code === c) || {}).name || c;

/* ── 切詞 ── */

test('英數依分隔符、大小寫與數字邊界切開', () => {
  const t = LM.tokens('E-CABLE-PWR-600');
  assert.ok(t.has('cable') && t.has('pwr') && t.has('600'));
  assert.ok(LM.tokens('CableTray600').has('tray'), 'camelCase 沒切開');
});

test('中文切成 2-gram —— 整串比對會讓「電纜」對不到「電纜架」', () => {
  const t = LM.tokens('電纜架');
  assert.ok(t.has('電纜') && t.has('纜架'), [...t].join(','));
});

test('單一中文字不會被丟掉', () => {
  assert.ok(LM.tokens('樑').has('樑'));
});

test('只取兩位以上的數字 —— 單一數字命中率太低、誤配太多', () => {
  const n = LM.numbersIn('梯型 600W×100H t=2.0mm');
  assert.ok(n.has('600') && n.has('100'));
  assert.ok(!n.has('2'), [...n].join(','));
});

test('標準編號可跨空格與連字號比對', () => {
  for (const s of ['CNS 11174', 'CNS11174', 'CNS-11174']) {
    assert.ok(LM.standardsIn(s).has('CNS11174'), s);
  }
});

/* ── 單項評分 ── */

test('關鍵字完全相同拿最高分', () => {
  const a = LM.scoreItem('E-WIRE', ITEMS[2], LINES);
  const b = LM.scoreItem('E-WIRE-3F', ITEMS[2], LINES);
  assert.ok(a.score > b.score, `${a.score} 應大於 ${b.score}`);
  assert.match(a.reasons.join(), /完全相同/);
});

test('每一分都附理由 —— 稽核時要答得出為什麼', () => {
  const r = LM.scoreItem('E-TRAY-600', ITEMS[3], LINES);
  assert.ok(r.reasons.length >= 2, r.reasons.join('|'));
  assert.ok(r.reasons.some((x) => x.includes('600')), '尺寸命中沒有寫進理由');
});

test('尺寸數字命中規格會加分', () => {
  const withNum = LM.scoreItem('E-TRAY-600', ITEMS[3], LINES).score;
  const without = LM.scoreItem('E-TRAY-999', ITEMS[3], LINES).score;
  assert.ok(withNum > without, `${withNum} 應大於 ${without}`);
});

test('幾何型態不符會被重扣 —— 計數工項對到只有線段的圖層是錯的', () => {
  const good = LM.scoreItem('E-LIGHT-HB', ITEMS[4], BLOCKS).score;
  const bad = LM.scoreItem('E-LIGHT-HB', ITEMS[4], LINES).score;
  assert.ok(good > bad, `${good} 應大於 ${bad}`);
  assert.match(LM.scoreItem('E-LIGHT-HB', ITEMS[4], LINES).reasons.join(), /型態不符/);
});

test('面積工項需要有封閉多段線，不是有面積數字就算', () => {
  const area = { code: 'A', name: '面', spec: '', measureType: 'area', layerHints: ['F-AREA'] };
  assert.ok(LM.scoreItem('F-AREA', area, CLOSED).score > LM.scoreItem('F-AREA', area, LINES).score);
});

test('完全無關的圖層得零分', () => {
  assert.equal(LM.scoreItem('A-GRID-AXIS', ITEMS[4], LINES).score, 0);
});

/* ── 對應決策：這裡才是重點 ── */

test('共用同一個關鍵字的兩個工項 → 拒絕自動選，並列出候選', () => {
  // 範本裡 321.01 與 321.02 的 layerHints 都有 E-CABLE-PWR。
  // 一條線在幾何上看不出是 38mm² 還是 22mm²，這是圖面沒有這個資訊。
  const m = LM.match('E-CABLE-PWR', ITEMS, LINES);
  assert.equal(m.best, null, `不應該自動選，卻選了 ${m.best}`);
  assert.ok(m.ambiguous.includes('321.01') && m.ambiguous.includes('321.02'), m.ambiguous.join(','));
  assert.match(LM.explain(m, nameOf), /無法分辨/);
});

test('關鍵字唯一時正常自動對應', () => {
  const m = LM.match('E-TRAY-600', ITEMS, LINES);
  assert.equal(m.best, '323.01');
  assert.equal(m.ambiguous.length, 0);
  assert.ok(m.band !== 'low', m.band);
});

test('圖塊圖層對到計數工項', () => {
  const m = LM.match('E-LIGHT-HB', ITEMS, BLOCKS);
  assert.equal(m.best, '331.01');
});

test('相似度不足時留白，而不是硬塞一個', () => {
  const m = LM.match('A-GRID', ITEMS, LINES);
  assert.equal(m.best, null);
  assert.ok(m.band === 'none' || m.band === 'low', m.band);
});

test('中文圖層名稱也對得到', () => {
  const m = LM.match('接地幹線', ITEMS, LINES);
  assert.equal(m.best, '350.01', JSON.stringify(m.all));
});

test('幾何型態可以推翻名稱很像的錯誤對應', () => {
  // 名稱像燈具，但圖層只有線段沒有圖塊 —— 不該算成 331.01 的數量
  const m = LM.match('E-LIGHT-HB', ITEMS, LINES);
  assert.notEqual(m.best, '331.01', `型態不符卻仍自動對應：${JSON.stringify(m.all[0])}`);
});

test('回傳的候選依分數排序，且不超過 5 筆', () => {
  const m = LM.match('E-CABLE-PWR', ITEMS, LINES);
  assert.ok(m.all.length <= 5);
  for (let i = 1; i < m.all.length; i++) assert.ok(m.all[i - 1].score >= m.all[i].score);
});

test('沒有幾何資訊時仍可對應（只是少了型態這一票）', () => {
  const m = LM.match('E-TRAY', ITEMS, null);
  assert.equal(m.best, '323.01');
});

test('explain 對每一種結果都給得出人話', () => {
  assert.match(LM.explain(LM.match('E-TRAY-600', ITEMS, LINES), nameOf), /分數 \d+/);
  assert.match(LM.explain(LM.match('E-CABLE-PWR', ITEMS, LINES), nameOf), /人工指定/);
  assert.match(LM.explain(LM.match('ZZZ-NOTHING', ITEMS, LINES), nameOf), /找不到|相似度不足/);
});

test('被幾何否決的候選仍留在清單裡，附上理由 —— 不可以憑空消失', () => {
  const m = LM.match('E-LIGHT-HB', ITEMS, LINES);
  const row = m.all.find((x) => x.code === '331.01');
  assert.ok(row, '被否決的候選不見了');
  assert.equal(row.blocked, true);
  assert.match(row.reasons.join(), /產不出/);
  assert.match(LM.explain(m, nameOf), /幾何型態不符/);
});
