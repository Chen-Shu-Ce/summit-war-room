/**
 * 重複描繪偵測的測試。
 *
 * 使用者說「得先做重複線段偵測，那比任何自動化都優先」——
 * 理由是它會靜默地把數量翻倍：對應猜錯了數字會不合理而被發現，
 * 重複描繪不會，它給你一個完全合理、但錯一倍的數字。
 *
 * 所以測試的重點是**數字要正確到可以拿去對帳**，不是「有偵測到」。
 * 每一個案例的重複長度都是手算得出來的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../public/js/takeoff/dedupe.js';

const TOL = 1;   // 圖檔單位 = mm，容差 1mm

const line = (layer, x1, y1, x2, y2) => ({ type: 'LINE', layer, pts: [{ x: x1, y: y1 }, { x: x2, y: y2 }] });
const poly = (layer, pts, closed = false) => ({ type: 'POLYLINE', layer, closed, pts: pts.map(([x, y]) => ({ x, y })) });
const ins = (layer, name, x, y) => ({ type: 'INSERT', layer, name, pt: { x, y } });
const circ = (layer, x, y, r) => ({ type: 'CIRCLE', layer, c: { x, y }, r });

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

/* ── 區間聯集 ── */

test('unionLength：不相交、相接、重疊、包含', () => {
  assert.equal(D.unionLength([[0, 10]]), 10);
  assert.equal(D.unionLength([[0, 10], [20, 30]]), 20);
  assert.equal(D.unionLength([[0, 10], [10, 20]]), 20);
  assert.equal(D.unionLength([[0, 10], [5, 20]]), 20);
  assert.equal(D.unionLength([[0, 100], [10, 20]]), 100, '被完全包含的區間不該增加聯集');
  assert.equal(D.unionLength([]), 0);
});

test('unionLength 不受輸入順序影響', () => {
  assert.equal(D.unionLength([[20, 30], [0, 10], [5, 25]]), 30);
});

/* ── 直線正規化 ── */

test('方向相反的兩條線是同一條直線 —— A→B 與 B→A 是最常見的重複', () => {
  const f = D.lineOf({ a: { x: 0, y: 0 }, b: { x: 100, y: 0 } });
  const r = D.lineOf({ a: { x: 100, y: 0 }, b: { x: 0, y: 0 } });
  assert.ok(near(f.theta, r.theta), `${f.theta} vs ${r.theta}`);
  assert.ok(near(f.c, r.c), `${f.c} vs ${r.c}`);
});

test('平行但不同位置的線，法向距離不同', () => {
  const a = D.lineOf({ a: { x: 0, y: 0 }, b: { x: 100, y: 0 } });
  const b = D.lineOf({ a: { x: 0, y: 50 }, b: { x: 100, y: 50 } });
  assert.ok(near(a.theta, b.theta));
  assert.ok(Math.abs(a.c - b.c) > 49, `${a.c} vs ${b.c}`);
});

test('零長度線段標成 degenerate', () => {
  assert.equal(D.lineOf({ a: { x: 5, y: 5 }, b: { x: 5, y: 5 } }).degenerate, true);
});

/* ── 共線重疊：數字要對得到帳 ── */

test('完全重合：畫兩遍 = 重複一整條', () => {
  const r = D.analyze([line('E', 0, 0, 5000, 0), line('E', 0, 0, 5000, 0)], { tol: TOL });
  const g = r.byLayer.get('E');
  assert.equal(g.total, 10000);
  assert.equal(g.union, 5000);
  assert.equal(g.duplicated, 5000);
  assert.equal(g.ratio, 0.5);
});

test('反向重合也算重複', () => {
  const g = D.analyze([line('E', 0, 0, 5000, 0), line('E', 5000, 0, 0, 0)], { tol: TOL }).byLayer.get('E');
  assert.equal(g.duplicated, 5000);
});

test('部分重疊：0–5000 與 3000–8000 → 總長 10000、聯集 8000、重複 2000', () => {
  const g = D.analyze([line('W', 0, 0, 5000, 0), line('W', 3000, 0, 8000, 0)], { tol: TOL }).byLayer.get('W');
  assert.equal(g.total, 10000);
  assert.equal(g.union, 8000);
  assert.equal(g.duplicated, 2000);
});

test('首尾相接不算重複 —— 這是正常畫法，誤報會讓人忽略警告', () => {
  const g = D.analyze([line('W', 0, 0, 5000, 0), line('W', 5000, 0, 9000, 0)], { tol: TOL }).byLayer.get('W');
  assert.equal(g.duplicated, 0);
  assert.equal(g.union, 9000);
});

test('平行但不共線不算重複', () => {
  const g = D.analyze([line('W', 0, 0, 5000, 0), line('W', 0, 300, 5000, 300)], { tol: TOL }).byLayer.get('W');
  assert.equal(g.duplicated, 0);
});

test('交叉的兩條線不算重複', () => {
  const g = D.analyze([line('W', 0, 0, 5000, 0), line('W', 2500, -2000, 2500, 2000)], { tol: TOL }).byLayer.get('W');
  assert.equal(g.duplicated, 0);
});

test('斜線也算得對（3-4-5 直角三角形）', () => {
  const g = D.analyze([line('E', 0, 0, 3000, 4000), line('E', 0, 0, 3000, 4000)], { tol: TOL }).byLayer.get('E');
  assert.ok(near(g.total, 10000, 1e-6), String(g.total));
  assert.ok(near(g.duplicated, 5000, 1e-6), String(g.duplicated));
});

test('一條多段線 vs 拆開的獨立線段 —— 拆開比才抓得到', () => {
  const flat = [
    poly('E', [[0, 0], [4000, 0], [4000, 3000]]),
    line('E', 0, 0, 4000, 0),
    line('E', 4000, 0, 4000, 3000),
  ];
  const g = D.analyze(flat, { tol: TOL }).byLayer.get('E');
  assert.equal(g.total, 14000);
  assert.equal(g.union, 7000);
  assert.equal(g.duplicated, 7000);
});

test('封閉多段線的收尾段有算進去', () => {
  const g = D.analyze([poly('A', [[0, 0], [1000, 0], [1000, 1000], [0, 1000]], true)], { tol: TOL }).byLayer.get('A');
  assert.equal(g.total, 4000, '封閉矩形周長應為 4000');
  assert.equal(g.duplicated, 0);
});

test('不同圖層各自計算，不互相污染', () => {
  const r = D.analyze([line('E', 0, 0, 100, 0), line('E', 0, 0, 100, 0), line('P', 0, 0, 100, 0)], { tol: TOL });
  assert.equal(r.byLayer.get('E').duplicated, 100);
  assert.equal(r.byLayer.get('P').duplicated, 0);
  assert.equal(r.totals.duplicated, 100);
});

test('容差內的微小偏移仍視為同一條線（CAD 的浮點誤差）', () => {
  const g = D.analyze([line('E', 0, 0, 5000, 0), line('E', 0, 0.3, 5000, 0.3)], { tol: TOL }).byLayer.get('E');
  assert.ok(g.duplicated > 4900, `0.3mm 的偏移應視為同一條，實得 ${g.duplicated}`);
});

test('容差外的偏移就是兩條不同的線', () => {
  const g = D.analyze([line('E', 0, 0, 5000, 0), line('E', 0, 50, 5000, 50)], { tol: TOL }).byLayer.get('E');
  assert.equal(g.duplicated, 0);
});

test('零長度線段被計數但不影響長度', () => {
  const g = D.analyze([line('E', 0, 0, 100, 0), line('E', 7, 7, 7, 7)], { tol: TOL }).byLayer.get('E');
  assert.equal(g.degenerate, 1);
  assert.equal(g.total, 100);
  assert.equal(g.duplicated, 0);
});

test('三條疊在一起：總長 300、聯集 100、重複 200', () => {
  const g = D.analyze([line('E', 0, 0, 100, 0), line('E', 0, 0, 100, 0), line('E', 0, 0, 100, 0)],
    { tol: TOL }).byLayer.get('E');
  assert.equal(g.duplicated, 200);
});

test('重複最嚴重的群排在最前面，並附一個樣本座標可供定位', () => {
  const g = D.analyze([
    line('E', 0, 0, 100, 0), line('E', 0, 0, 100, 0),
    line('E', 0, 500, 9000, 500), line('E', 0, 500, 9000, 500),
  ], { tol: TOL }).byLayer.get('E');
  assert.equal(g.groups.length, 2);
  assert.ok(g.groups[0].duplicated > g.groups[1].duplicated);
  assert.ok(g.groups[0].sample && typeof g.groups[0].sample.a.x === 'number');
});

/* ── 相同幾何的實體 ── */

test('同名圖塊插在同一點 → 計數被灌水（燈具、插座最常見）', () => {
  const r = D.analyze([ins('L', 'LED-HB', 100, 100), ins('L', 'LED-HB', 100, 100), ins('L', 'LED-HB', 900, 100)],
    { tol: TOL });
  const g = r.byLayer.get('L');
  assert.equal(g.dupInserts, 1, '三個插入、其中兩個同點，應多算 1 個');
  assert.equal(r.totals.dupInserts, 1);
});

test('不同點的同名圖塊不是重複', () => {
  const r = D.analyze([ins('L', 'LED-HB', 0, 0), ins('L', 'LED-HB', 1000, 0)], { tol: TOL });
  assert.equal(r.totals.dupInserts, 0);
});

test('同點但不同圖塊不是重複', () => {
  const r = D.analyze([ins('L', 'LED-HB', 0, 0), ins('L', 'EXIT', 0, 0)], { tol: TOL });
  assert.equal(r.totals.dupInserts, 0);
});

test('相同的圓被偵測出來', () => {
  const r = D.analyze([circ('C', 0, 0, 300), circ('C', 0, 0, 300)], { tol: TOL });
  const d = r.byLayer.get('C').dupEntities;
  assert.equal(d.length, 1);
  assert.equal(d[0].extra, 1);
});

/* ── 嚴重度與說明 ── */

test('乾淨的圖判為 clean', () => {
  const r = D.analyze([line('E', 0, 0, 100, 0), line('E', 100, 0, 200, 0)], { tol: TOL });
  assert.equal(r.clean, true);
  assert.equal(D.severity(r.byLayer.get('E')), 'ok');
});

test('圖塊重複一律是 bad —— 計數多一個就是採購單多一個', () => {
  const r = D.analyze([ins('L', 'X', 0, 0), ins('L', 'X', 0, 0)], { tol: TOL });
  assert.equal(D.severity(r.byLayer.get('L')), 'bad');
  assert.equal(r.clean, false);
});

test('長度灌水 2% 以上是 bad，以下是 warn', () => {
  // 總長 10000，重複 300 → 3%
  const bad = D.analyze([line('E', 0, 0, 4850, 0), line('E', 4550, 0, 9700, 0)], { tol: TOL }).byLayer.get('E');
  assert.ok(bad.ratio >= 0.02, String(bad.ratio));
  assert.equal(D.severity(bad), 'bad');
  // 總長 100000，重複 100 → 0.1%
  const warn = D.analyze([line('E', 0, 0, 50000, 0), line('E', 49900, 0, 99900, 0)], { tol: TOL }).byLayer.get('E');
  assert.ok(warn.ratio > 0 && warn.ratio < 0.02, String(warn.ratio));
  assert.equal(D.severity(warn), 'warn');
});

test('describe 說得出重複多少、佔幾成，且可換算成公尺', () => {
  const g = D.analyze([line('E', 0, 0, 5000, 0), line('E', 0, 0, 5000, 0)], { tol: TOL }).byLayer.get('E');
  const s = D.describe(g, 0.001);
  assert.match(s, /重複 5\.0 M/, s);
  assert.match(s, /50\.0%/, s);
  assert.equal(D.describe(D.analyze([line('E', 0, 0, 100, 0)], { tol: TOL }).byLayer.get('E')), '無重複');
});

/* ── 規模 ── */

test('一萬條線段跑得完，而且不會誤報', () => {
  const flat = [];
  for (let i = 0; i < 10000; i++) flat.push(line('E', 0, i * 10, 1000, i * 10));
  const t0 = Date.now();
  const r = D.analyze(flat, { tol: TOL });
  assert.equal(r.totals.duplicated, 0, '互相平行的線不該被判成重複');
  assert.ok(Date.now() - t0 < 4000, `太慢：${Date.now() - t0}ms`);
});

/* ── 邊界：theta 的 0 / π 交界 ── */

test('幾乎水平但方向相反的重複線不可以漏掉（theta 在 0 與 π 的交界）', () => {
  // 一條 theta≈0、一條 theta≈π —— 幾何上是同一條線，排序後卻落在陣列兩端
  const flat = [
    { type: 'LINE', layer: 'E', pts: [{ x: 0, y: 0 }, { x: 5000, y: 0.2 }] },
    { type: 'LINE', layer: 'E', pts: [{ x: 5000, y: 0.2 }, { x: 0, y: 0 }] },
  ];
  const g = D.analyze(flat, { tol: TOL }).byLayer.get('E');
  assert.ok(g.duplicated > 4900, `完全重合卻只抓到 ${g.duplicated}`);
});

test('只有圖塊、沒有線段的圖層，ratio 要是 0 不是 undefined', () => {
  const g = D.analyze([ins('L', 'X', 0, 0), ins('L', 'X', 0, 0)], { tol: TOL }).byLayer.get('L');
  assert.equal(g.ratio, 0, String(g.ratio));
  assert.ok(!Number.isNaN(g.ratio));
  assert.doesNotMatch(D.describe(g, 0.001), /NaN|undefined/);
});

test('斜率一正一負但幾乎重合的線，不可以因為 θ 落在陣列兩端而漏報', () => {
  // 5000 長、斜率 ±1e-5 → 末端只差 0.1mm，實務上就是同一條線畫了兩次
  const g = D.analyze([
    { type: 'LINE', layer: 'E', pts: [{ x: 0, y: 0 }, { x: 5000, y: 0.05 }] },
    { type: 'LINE', layer: 'E', pts: [{ x: 0, y: 0 }, { x: 5000, y: -0.05 }] },
  ], { tol: TOL }).byLayer.get('E');
  assert.ok(g.duplicated > 4900, `應抓到約 5000 的重複，實得 ${g.duplicated}`);
});
