/**
 * 產生 tests/fixture-titleblock.pdf —— 重現一張真實施工圖暴露的問題。
 *
 * 刻意**不使用**使用者提供的真實施工圖：那是他們的專案圖說，不應進版控。
 * 這裡用最小的 PDF 重現同樣的條件：
 *
 *   1. 紙張精確為 A1 橫式（2384 × 1684 pt = 841.0 × 594.0 mm）。
 *   2. 圖框寫著「A1圖:1:100」與「A3圖:1:200」—— 同一張圖標兩個比例。
 *   3. 但 SECTION A-A 的「600」尺寸線在紙上畫成 59.97 mm ——
 *      那一區實際是 **1:10**，跟圖框差十倍。
 *
 * 這三件事湊起來就是這個功能的全部風險：讀得到圖框比例很有用，
 * 但整張套下去，大樣的量測會整批錯十倍，而且畫面上完全正常。
 *
 * 零相依：手寫 PDF 位元組，不引入任何 PDF 產生器。
 */
import { writeFile } from 'node:fs/promises';

const W = 2384, H = 1684;               // A1 橫式，單位 pt
const PT_MM = 25.4 / 72;
const DIM_PT = 600 / 10 / PT_MM;        // 600mm 以 1:10 畫 = 60mm 紙上 = 170.08 pt

/** WinAnsi 可編的字串（PDF 字面字串需跳脫）。 */
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/** 中文用 UTF-16BE + Identity-H 太複雜；圖框比例欄本來就是 ASCII，用 ASCII 即可。 */
const content = [
  // 圖框外框
  '0.6 w',
  `40 40 ${W - 80} ${H - 80} re S`,
  // 標題欄（右下）
  `${W - 700} 40 660 160 re S`,
  // 比例欄文字 —— 這就是要被讀出來的兩行
  'BT /F1 18 Tf 1 0 0 1 ' + (W - 680) + ' 150 Tm (A3' + esc('圖') + ':1:200) Tj ET',
  'BT /F1 18 Tf 1 0 0 1 ' + (W - 680) + ' 120 Tm (A1' + esc('圖') + ':1:100) Tj ET',
  'BT /F1 14 Tf 1 0 0 1 ' + (W - 680) + ' 90 Tm (SCALE) Tj ET',
  'BT /F1 14 Tf 1 0 0 1 ' + (W - 680) + ' 65 Tm (TEST SHEET - PILE DETAIL) Tj ET',

  // ── SECTION A-A：以 1:10 繪製的 φ600 樁 ──
  // 尺寸線（水平），長度剛好 = 600mm @ 1:10
  '1 w',
  `2000 1250 m ${2000 + DIM_PT} 1250 l S`,
  `2000 1240 m 2000 1260 l S`,
  `${2000 + DIM_PT} 1240 m ${2000 + DIM_PT} 1260 l S`,
  'BT /F1 16 Tf 1 0 0 1 ' + (2000 + DIM_PT / 2 - 15) + ' 1265 Tm (600) Tj ET',
  'BT /F1 20 Tf 1 0 0 1 2000 1180 Tm (SECTION A-A) Tj ET',
  // 樁斷面（圓，以貝茲近似），直徑同為 DIM_PT
  ...circle(2000 + DIM_PT / 2, 1400, DIM_PT / 2),
  ...circle(2000 + DIM_PT / 2, 1400, DIM_PT / 2 - 12 / PT_MM / 10),   // 內圓，壁厚 120mm @1:10

  // ── 主視圖：以 1:100 繪製的 6000mm 長構件 ──
  // 6000mm @ 1:100 = 60mm 紙上 = 同樣 170.08 pt。這是刻意的：
  // 兩條線在紙上一樣長，代表的實際尺寸卻差十倍 —— 正是這個問題的本質。
  `400 1250 m ${400 + DIM_PT} 1250 l S`,
  `400 1240 m 400 1260 l S`,
  `${400 + DIM_PT} 1240 m ${400 + DIM_PT} 1260 l S`,
  'BT /F1 16 Tf 1 0 0 1 ' + (400 + DIM_PT / 2 - 20) + ' 1265 Tm (6000) Tj ET',
  'BT /F1 20 Tf 1 0 0 1 400 1180 Tm (PLAN) Tj ET',
  `400 1300 ${DIM_PT} 200 re S`,
].join('\n');

function circle(cx, cy, r) {
  const k = 0.5522847498 * r;
  return [
    `${(cx + r).toFixed(2)} ${cy.toFixed(2)} m`,
    `${(cx + r).toFixed(2)} ${(cy + k).toFixed(2)} ${(cx + k).toFixed(2)} ${(cy + r).toFixed(2)} ${cx.toFixed(2)} ${(cy + r).toFixed(2)} c`,
    `${(cx - k).toFixed(2)} ${(cy + r).toFixed(2)} ${(cx - r).toFixed(2)} ${(cy + k).toFixed(2)} ${(cx - r).toFixed(2)} ${cy.toFixed(2)} c`,
    `${(cx - r).toFixed(2)} ${(cy - k).toFixed(2)} ${(cx - k).toFixed(2)} ${(cy - r).toFixed(2)} ${cx.toFixed(2)} ${(cy - r).toFixed(2)} c`,
    `${(cx + k).toFixed(2)} ${(cy - r).toFixed(2)} ${(cx + r).toFixed(2)} ${(cy - k).toFixed(2)} ${(cx + r).toFixed(2)} ${cy.toFixed(2)} c`,
    'S',
  ];
}

function buildPdf(body) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    null,   // 4: content stream
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objs.length; i++) {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    if (i === 3) {
      out += `4 0 obj\n<< /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}\nendstream\nendobj\n`;
    } else {
      out += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
    }
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

await writeFile(new URL('./fixture-titleblock.pdf', import.meta.url), buildPdf(content));
console.log(`wrote fixture-titleblock.pdf — A1 ${W}x${H}pt，圖框標 1:100，但 SECTION A-A 的 600mm 線畫成 ${DIM_PT.toFixed(2)}pt（1:10）`);
