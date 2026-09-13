/**
 * 測試用的最小 ZIP 讀取器 —— 只為了把我們自己寫出去的 .xlsx 再讀回來驗。
 *
 * 刻意不用任何套件：匯出這條路的重點就是「零相依也要產得出合法的活頁簿」，
 * 驗證端如果靠一套第三方解析器，等於把最需要被驗的那一段外包出去。
 */
import { inflateRawSync } from 'node:zlib';

/** 解開 ZIP，回傳 Map<檔名, Buffer>。順便驗證中央目錄與本地檔頭一致。 */
export function unzip(bytes, { crc32 } = {}) {
  const buf = Buffer.from(bytes);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('找不到 EOCD，這不是一個 ZIP');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error(`第 ${i} 筆中央目錄簽章錯誤`);
    const method = buf.readUInt16LE(off + 10);
    const crc = buf.readUInt32LE(off + 16);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nlen);
    if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error(`${name} 的本地檔頭簽章錯誤`);
    if (buf.readUInt32LE(lho + 14) !== crc) throw new Error(`${name} 的 CRC 在兩處不一致`);
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(start, start + csize);
    const data = method === 0 ? raw : inflateRawSync(raw);
    if (data.length !== usize) throw new Error(`${name} 解出的長度與宣告不符`);
    if (crc32 && crc32(data) !== crc) throw new Error(`${name} 的 CRC 對不上內容`);
    out.set(name, data);
    off += 46 + nlen + elen + clen;
  }
  return out;
}

const UNESC = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/**
 * 把 .xlsx 讀成 { sheets: [{ name, rows }], text }。
 *
 * rows 是字串陣列 —— 測試只在意「這個值有沒有出現、在第幾欄」，
 * 型別本身由 xlsx.test.mjs 直接驗 XML，這裡不重複。
 */
export function readXlsx(bytes) {
  const files = unzip(bytes);
  const wb = files.get('xl/workbook.xml').toString('utf8');
  const names = [...wb.matchAll(/<sheet name="([^"]*)"/g)].map((m) => UNESC(m[1]));
  const sheets = [];
  for (let i = 1; files.has(`xl/worksheets/sheet${i}.xml`); i++) {
    const xml = files.get(`xl/worksheets/sheet${i}.xml`).toString('utf8');
    const rows = [];
    for (const rm of xml.matchAll(/<row [^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cm of rm[1].matchAll(/<c r="([A-Z]+)\d+"[^>]*>([\s\S]*?)<\/c>/g)) {
        let col = 0;
        for (const ch of cm[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
        const inline = cm[2].match(/<t[^>]*>([\s\S]*?)<\/t>/);
        const num = cm[2].match(/<v>([\s\S]*?)<\/v>/);
        while (cells.length < col - 1) cells.push('');
        cells[col - 1] = inline ? UNESC(inline[1]) : (num ? UNESC(num[1]) : '');
      }
      rows.push(cells);
    }
    sheets.push({ name: names[i - 1] ?? `sheet${i}`, rows });
  }
  // text 方便做「有沒有包含某字串」這種寬鬆斷言
  const text = sheets.map((s) => s.rows.map((r) => r.join(',')).join('\n')).join('\n');
  return { sheets, text, files };
}
