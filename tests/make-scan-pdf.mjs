/**
 * 產生 tests/fixture-scan.pdf —— 重現一份真實標單圖的條件。
 *
 * 刻意**不使用**使用者提供的真實標單圖：那是軍方營舍的工程圖說，不應進版控。
 * 這裡用最小的 PDF 重現同樣的性質：
 *
 *   1. A3 橫式（1191 × 842 pt = 420.0 × 297.0 mm），紙張精確吻合。
 *   2. 整頁只有一個 paintImageXObject —— 純掃描，零文字、零向量。
 *   3. 因此圖框上就算寫著「NO SCALE」也讀不到，工具必須說「我判斷不了，請人眼看」。
 *
 * 另外產生 fixture-nts.pdf：同樣是 A3，但**有文字**且比例欄寫「NO SCALE」，
 * 用來測「讀得到文字時要自動偵測出不按比例」。
 *
 * 零相依：手寫 PDF 位元組 + node 內建 zlib。
 */
import { writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

const W = 1191, H = 842;          // A3 橫式
const IW = 120, IH = 85;          // 掃描影像的像素尺寸（小一點，測試檔才不會肥）

/** 畫一張「看起來像圖面」的灰階點陣圖：外框 + 幾條線 + 一塊網格。 */
function rasterise() {
  const px = new Uint8Array(IW * IH).fill(0xff);
  const set = (x, y) => { if (x >= 0 && x < IW && y >= 0 && y < IH) px[y * IW + x] = 0x20; };
  for (let x = 4; x < IW - 4; x++) { set(x, 4); set(x, IH - 5); }
  for (let y = 4; y < IH - 5; y++) { set(4, y); set(IW - 5, y); }
  for (let x = 12; x < 60; x++) { set(x, 20); set(x, 55); }
  for (let y = 20; y < 55; y++) { set(12, y); set(59, y); }
  for (let gx = 70; gx < 112; gx += 6) for (let y = 20; y < 56; y++) set(gx, y);
  for (let gy = 20; gy < 56; gy += 6) for (let x = 70; x < 112; x++) set(x, gy);
  // 標題欄
  for (let x = 12; x < IW - 12; x++) { set(x, IH - 16); }
  for (let y = IH - 16; y < IH - 5; y++) { set(40, y); set(80, y); }
  return Buffer.from(px);
}

function buildPdf({ scanned, texts = [] }) {
  const objs = [];
  const push = (body) => { objs.push(body); return objs.length; };   // 回傳 1-based 物件編號

  const catalog = push(null), pages = push(null), page = push(null), content = push(null);
  let fontObj = null, imgObj = null;

  const parts = [];
  if (scanned) {
    imgObj = push(null);
    // 影像鋪滿整頁
    parts.push('q', `${W} 0 0 ${H} 0 0 cm`, `/Im0 Do`, 'Q');
  } else {
    parts.push('0.6 w', `40 40 ${W - 80} ${H - 80} re S`,
      `${W - 520} 40 480 90 re S`);
    fontObj = push(null);
    let y = 100;
    for (const t of texts) { parts.push(`BT /F1 16 Tf 1 0 0 1 ${W - 500} ${y} Tm (${t}) Tj ET`); y -= 26; }
  }
  const body = parts.join('\n');

  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`;
  objs[pages - 1] = `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`;
  const res = scanned
    ? `<< /XObject << /Im0 ${imgObj} 0 R >> >>`
    : `<< /Font << /F1 ${fontObj} 0 R >> >>`;
  objs[page - 1] = `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${W} ${H}] /Resources ${res} /Contents ${content} 0 R >>`;
  if (fontObj) objs[fontObj - 1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

  // 組檔
  let out = Buffer.from('%PDF-1.4\n', 'latin1');
  const offsets = new Array(objs.length + 1).fill(0);
  const append = (b) => { out = Buffer.concat([out, Buffer.from(b, 'latin1')]); };
  const appendBuf = (b) => { out = Buffer.concat([out, b]); };

  for (let i = 1; i <= objs.length; i++) {
    offsets[i] = out.length;
    if (i === content) {
      append(`${i} 0 obj\n<< /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}\nendstream\nendobj\n`);
    } else if (scanned && i === imgObj) {
      const z = deflateSync(rasterise());
      append(`${i} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${IW} /Height ${IH}`
        + ` /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${z.length} >>\nstream\n`);
      appendBuf(z);
      append('\nendstream\nendobj\n');
    } else {
      append(`${i} 0 obj\n${objs[i - 1]}\nendobj\n`);
    }
  }
  const xref = out.length;
  append(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`);
  for (let i = 1; i <= objs.length; i++) append(String(offsets[i]).padStart(10, '0') + ' 00000 n \n');
  append(`trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return out;
}

const base = new URL('.', import.meta.url);
// 純掃描：零文字、零向量，只有一張點陣圖
await writeFile(new URL('./fixture-scan.pdf', base), buildPdf({ scanned: true }));
// 有文字、比例欄寫 NO SCALE
await writeFile(new URL('./fixture-nts.pdf', base), buildPdf({
  scanned: false,
  texts: ['SCALE', 'NO SCALE', 'UNIT CM', 'TENDER DRAWING'],
}));
console.log('wrote fixture-scan.pdf（純掃描 A3）/ fixture-nts.pdf（A3，比例欄 NO SCALE）');
