#!/usr/bin/env node
/**
 * layer-audit.mjs —— 在**你自己的電腦上**跑，產生一份可以外傳的統計檔。
 *
 * 為什麼需要這支東西：
 *
 * 要把「圖層 → 工項」的對應規則調準、要確認重複描繪的門檻訂得對不對，
 * 需要幾十張真實圖的資料。但標單圖說是機密，不能上傳，也不該上傳。
 *
 * 所以這支腳本只讀圖、只輸出**統計數字與圖層名稱**：
 *
 *   會輸出：圖層名稱、各圖層的總長／總面積／實體數／圖塊名稱與個數、
 *           重複描繪的長度與比例、重疊圖塊數、各類實體的數量、圖檔單位。
 *
 *   不會輸出：任何座標、任何文字內容（TEXT／MTEXT／標註）、
 *             圖框與標題欄、尺寸數值、檔案原始位元組。
 *             檔名預設也會換成 A、B、C…（要保留請加 --keep-names）。
 *
 * 輸出檔請自己先打開看過再決定要不要外傳 —— 腳本會把疑似含專案資訊的
 * 圖層名稱（含中文、或含 5 位以上連續數字）另外列出來提醒你。
 *
 * 用法：
 *   node tools/layer-audit.mjs 圖面資料夾 > audit.json
 *   node tools/layer-audit.mjs a.dxf b.dxf --keep-names > audit.json
 *
 * 只吃 ASCII DXF。DWG 請先用 ODA File Converter 或 dwg2dxf 轉出 DXF ——
 * 那一步也在你自己的電腦上，圖同樣不出公司。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as DXF from '../public/js/takeoff/dxf.js';
import * as ENC from '../public/js/takeoff/encoding.js';
import * as DD from '../public/js/takeoff/dedupe.js';

const args = process.argv.slice(2);
const keepNames = args.includes('--keep-names');
const inputs = args.filter((a) => !a.startsWith('--'));

if (!inputs.length) {
  console.error(`用法：node tools/layer-audit.mjs <資料夾或 .dxf 檔…> [--keep-names] > audit.json

只輸出統計數字與圖層名稱，不輸出任何座標或文字內容。
輸出檔請自己先看過再決定要不要外傳。`);
  process.exit(1);
}

/** 展開資料夾，收集所有 .dxf。 */
function collect(paths) {
  const out = [];
  for (const p of paths) {
    let st;
    try { st = statSync(p); } catch { console.error(`跳過（讀不到）：${p}`); continue; }
    if (st.isDirectory()) {
      for (const f of readdirSync(p)) {
        const full = join(p, f);
        try { if (statSync(full).isFile() && extname(f).toLowerCase() === '.dxf') out.push(full); } catch { /* 忽略 */ }
      }
    } else if (extname(p).toLowerCase() === '.dxf') out.push(p);
    else console.error(`跳過（不是 .dxf）：${p}`);
  }
  return out.sort();
}

/** 疑似帶專案資訊的圖層名稱 —— 中文，或 5 位以上連續數字（標案號、地號）。 */
const SUSPECT = /[一-鿿]|\d{5,}/;

/** 檔名代號：A、B、…、Z、AA、AB… */
function label(i) {
  let s = '';
  do { s = String.fromCharCode(65 + (i % 26)) + s; i = Math.floor(i / 26) - 1; } while (i >= 0);
  return s;
}

const files = collect(inputs);
if (!files.length) { console.error('沒有找到任何 .dxf'); process.exit(1); }

const report = { tool: 'layer-audit', version: 1, at: new Date().toISOString(), drawings: [] };
const suspects = new Set();
let ok = 0, failed = 0;

files.forEach((path, i) => {
  const name = keepNames ? basename(path) : `圖${label(i)}`;
  let d;
  try {
    const buf = readFileSync(path);
    const enc = ENC.decodeDxf(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const doc = DXF.parseDxf(enc.text);
    const flat = DXF.flatten(doc);
    const agg = DXF.aggregateByLayer(doc);
    const toM = doc.units && doc.units.toM;
    // 容差固定用 1mm；圖檔沒定義單位時退回圖幅對角線的百萬分之一
    let tol;
    if (toM) tol = 0.001 / toM;
    else {
      const b = DXF.bounds(doc);
      tol = Math.hypot((b.maxX - b.minX) || 1, (b.maxY - b.minY) || 1) * 1e-6;
    }
    const dup = DD.analyze(flat, { tol });

    const types = {};
    for (const e of flat) types[e.type] = (types[e.type] || 0) + 1;

    d = {
      name,
      encoding: enc.encoding,
      units: doc.units ? doc.units.name : null,
      metersPerUnit: toM || null,
      entities: flat.length,
      types,
      tol,
      duplicateTotals: dup.totals,
      layers: agg.map((g) => {
        if (SUSPECT.test(g.layer)) suspects.add(g.layer);
        const dg = dup.byLayer.get(g.layer);
        return {
          layer: g.layer,
          length: round(g.length), area: round(g.area), count: g.count,
          closed: g.closedCount, open: g.openCount,
          types: g.types,
          // 圖塊名稱是判斷「這一層放的是什麼設備」的關鍵線索，保留；
          // 名稱本身也走同一套可疑字元檢查
          blocks: Object.fromEntries(Object.entries(g.blocks).map(([n, c]) => {
            if (SUSPECT.test(n)) suspects.add(n);
            return [n, c];
          })),
          duplicated: dg ? round(dg.duplicated) : 0,
          dupRatio: dg ? +(dg.ratio || 0).toFixed(4) : 0,
          dupInserts: dg ? dg.dupInserts : 0,
          degenerate: dg ? dg.degenerate : 0,
          severity: dg ? DD.severity(dg) : 'ok',
        };
      }),
    };
    ok++;
  } catch (e) {
    d = { name, error: String(e && e.message || e) };
    failed++;
  }
  report.drawings.push(d);
});

function round(v) { return Number.isFinite(v) ? +v.toFixed(3) : 0; }

report.summary = {
  drawings: report.drawings.length,
  parsed: ok,
  failed,
  layers: report.drawings.reduce((a, d) => a + (d.layers ? d.layers.length : 0), 0),
  blockedLayers: report.drawings.reduce((a, d) =>
    a + (d.layers ? d.layers.filter((l) => l.severity === 'bad').length : 0), 0),
};

process.stdout.write(JSON.stringify(report, null, 1) + '\n');

/* ── 給人看的摘要走 stderr，不會混進 audit.json ── */
const S = report.summary;
console.error(`
讀了 ${S.drawings} 張圖（成功 ${S.parsed}、失敗 ${failed}），共 ${S.layers} 個圖層。`);
console.error(`其中 ${S.blockedLayers} 個圖層會因重複描繪被擋下。`);
for (const d of report.drawings) {
  if (d.error) { console.error(`  ${d.name}：解析失敗 —— ${d.error}`); continue; }
  const t = d.duplicateTotals;
  const pct = (t.ratio * 100).toFixed(1);
  console.error(`  ${d.name}：${d.layers.length} 層、${d.entities} 實體、`
    + `單位 ${d.units || '未定義'}、編碼 ${d.encoding}、重複 ${pct}%`
    + (t.dupInserts ? `、重疊圖塊 ${t.dupInserts}` : ''));
}
if (suspects.size) {
  console.error(`
⚠ 下面的圖層／圖塊名稱含中文或長數字，可能帶專案資訊，外傳前請自己確認：`);
  for (const x of [...suspects].sort()) console.error(`    ${x}`);
} else {
  console.error(`
圖層與圖塊名稱都沒有中文或長數字，看起來不帶專案資訊。`);
}
console.error(`
輸出只含統計數字與圖層名稱 —— 沒有座標、沒有文字內容、沒有圖框。
請自己打開 audit.json 看過再決定要不要外傳。`);

if (process.argv[1] !== fileURLToPath(import.meta.url)) { /* 被 import 時不做事 */ }
