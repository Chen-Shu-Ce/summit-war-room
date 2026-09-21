/**
 * xlsx.js — 零相依的 Excel (.xlsx) 產生器（純函式，不碰 DOM）
 *
 * 為什麼不用 CSV：
 *   CSV 沒有編碼欄位，Excel 只能用**系統碼頁**去猜。繁體中文 Windows 猜 Big5，
 *   於是 UTF-8 的中文全變亂碼；加了 BOM 有時有效、有時被當成資料的一部分；
 *   而且 CSV 只有一張表，工項／採購包／工序／請購單得拆成好幾個檔。
 *
 *   .xlsx 內部就是 UTF-8 XML，**編碼不是用猜的**，而且一個檔可以放多張工作表。
 *
 * 怎麼做到零相依：
 *   .xlsx 是一個 ZIP，裡面放幾份 XML。ZIP 允許「不壓縮（STORED）」的項目，
 *   所以只要會算 CRC-32 就能手寫出合法的 ZIP —— 不需要 deflate，不需要任何套件。
 *   代價是檔案比較大，但一份採購清單頂多幾百 KB，無所謂。
 */

/* ────────── ZIP（STORED，不壓縮） ────────── */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const enc = new TextEncoder();

/** 把 {path: string|Uint8Array} 打包成 ZIP（全部 STORED）。 */
export function zip(files) {
  const entries = [];
  let offset = 0;
  const chunks = [];

  const u16 = (n) => [n & 0xFF, (n >>> 8) & 0xFF];
  const u32 = (n) => [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF];

  for (const [path, content] of Object.entries(files)) {
    const name = enc.encode(path);
    const data = typeof content === 'string' ? enc.encode(content) : content;
    const crc = crc32(data);
    const local = new Uint8Array([
      0x50, 0x4B, 0x03, 0x04,       // 本地檔頭簽章
      ...u16(20), ...u16(0), ...u16(0),   // 版本、旗標、壓縮方式 0=STORED
      ...u16(0), ...u16(0),               // 時間、日期（固定值，可重現）
      ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(name.length), ...u16(0),
    ]);
    chunks.push(local, name, data);
    entries.push({ name, crc, size: data.length, offset });
    offset += local.length + name.length + data.length;
  }

  const central = [];
  let centralSize = 0;
  for (const e of entries) {
    const head = new Uint8Array([
      0x50, 0x4B, 0x01, 0x02,
      ...u16(20), ...u16(20), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0),
      ...u32(e.crc), ...u32(e.size), ...u32(e.size),
      ...u16(e.name.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0),
      ...u32(e.offset),
    ]);
    central.push(head, e.name);
    centralSize += head.length + e.name.length;
  }
  const end = new Uint8Array([
    0x50, 0x4B, 0x05, 0x06,
    ...u16(0), ...u16(0),
    ...u16(entries.length), ...u16(entries.length),
    ...u32(centralSize), ...u32(offset), ...u16(0),
  ]);

  const all = [...chunks, ...central, end];
  const total = all.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of all) { out.set(c, p); p += c.length; }
  return out;
}

/* ────────── XML ────────── */

/**
 * XML 逸出。順便濾掉 XML 1.0 不合法的控制字元 ——
 * 留著會讓整個 .xlsx 開不起來，而那比少一個看不見的字元嚴重得多。
 */
function esc(s) {
  let out = '';
  for (const ch of String(s ?? '')) {
    const c = ch.codePointAt(0);
    if (c < 0x20 && c !== 0x09 && c !== 0x0A && c !== 0x0D) continue;
    if (ch === '&') out += '&amp;';
    else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === '"') out += '&quot;';
    else if (ch === "'") out += '&apos;';
    else out += ch;
  }
  return out;
}

/** 0→A, 25→Z, 26→AA */
export function colName(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * 一張工作表。
 *
 * 數字寫成數字、文字寫成 inlineStr —— 不做 sharedStrings，
 * 因為那要維護一張全域字串表，對這個規模的資料只是徒增出錯機會。
 */
function sheetXml(rows, opts = {}) {
  const widths = opts.widths || [];
  const cols = widths.length
    ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : '';
  const freeze = opts.freezeHeader === false ? ''
    : '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>';

  const body = rows.map((row, r) => {
    const cells = (row || []).map((v, c) => {
      const ref = `${colName(c)}${r + 1}`;
      const style = r === 0 ? ' s="1"' : '';
      if (v === null || v === undefined || v === '') return `<c r="${ref}"${style}/>`;
      if (isNum(v)) return `<c r="${ref}"${style}><v>${v}</v></c>`;
      return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
    }).join('');
    return `<row r="${r + 1}">${cells}</row>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${freeze}${cols}<sheetData>${body}</sheetData></worksheet>`;
}

/** Excel 的工作表名稱限制：31 字、不得含 : \ / ? * [ ]，且不得重複。 */
export function safeSheetName(name, used = new Set()) {
  let s = String(name || 'Sheet').replace(/[:\\/?*[\]]/g, '_').slice(0, 31) || 'Sheet';
  if (!used.has(s)) { used.add(s); return s; }
  for (let i = 2; i < 1000; i++) {
    const t = `${s.slice(0, 28)}_${i}`;
    if (!used.has(t)) { used.add(t); return t; }
  }
  return s;
}

/**
 * 產生 .xlsx 的位元組。
 *
 * sheets = [{ name, rows:[[...]], widths?:[] }]
 * 第一列一律視為表頭（粗體 + 凍結）。
 */
export function build(sheets) {
  const list = (sheets || []).filter((s) => s && Array.isArray(s.rows));
  if (!list.length) throw new Error('沒有任何工作表可以匯出');
  const used = new Set();
  const named = list.map((s) => ({ ...s, name: safeSheetName(s.name, used) }));

  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${named.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`,

    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,

    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${named.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`,

    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${named.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,

    // 兩個 cellXfs：0 = 一般、1 = 粗體（表頭）
    'xl/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`,
  };

  named.forEach((s, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(s.rows, s); });
  return zip(files);
}

/** 由列資料估算欄寬（中日韓字算兩格）。 */
export function autoWidths(rows, { min = 8, max = 46 } = {}) {
  const n = rows.reduce((a, r) => Math.max(a, (r || []).length), 0);
  const w = new Array(n).fill(min);
  for (const row of rows) {
    (row || []).forEach((v, i) => {
      const s = v == null ? '' : String(v);
      let len = 0;
      for (const ch of s) len += (ch.codePointAt(0) > 0x2E80 ? 2 : 1);
      w[i] = Math.min(max, Math.max(w[i], len + 2));
    });
  }
  return w;
}

/** 同樣的資料轉成 TSV —— 貼進 Excel 就是正確的分欄，不經過任何編碼猜測。 */
export function toTsv(rows) {
  return (rows || []).map((r) => (r || [])
    .map((v) => String(v ?? '').replace(/[\t\r\n]/g, ' '))
    .join('\t')).join('\n');
}

/* ══════════ 讀取 ══════════ */

/**
 * 解 ZIP。只處理 stored(0) 與 deflate(8) —— .xlsx 只會用這兩種。
 *
 * 解壓用瀏覽器內建的 DecompressionStream('deflate-raw')，不引第三方程式庫。
 * Node 18+ 也有同一個 API，所以測試跑得動。
 */
export async function unzip(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  // 從尾端找中央目錄結束標記（EOCD）。註解最長 65535，所以只掃末段。
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP／xlsx 檔（找不到中央目錄）');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map();
  const dec = new TextDecoder('utf-8');
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const cmtLen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    // 本地檔頭的 extra 長度可能與中央目錄不同，必須從本地檔頭讀
    const lNameLen = dv.getUint16(lho + 26, true);
    const lExtraLen = dv.getUint16(lho + 28, true);
    const start = lho + 30 + lNameLen + lExtraLen;
    out.set(name, { method, bytes: u8.subarray(start, start + csize) });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  const files = new Map();
  for (const [name, e] of out) {
    if (e.method === 0) { files.set(name, e.bytes); continue; }
    if (e.method !== 8) continue;                       // 其他壓縮法不支援，略過而不是整份失敗
    const ds = new DecompressionStream('deflate-raw');
    const ab = await new Response(new Blob([e.bytes]).stream().pipeThrough(ds)).arrayBuffer();
    files.set(name, new Uint8Array(ab));
  }
  return files;
}

const XTEXT = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&amp;/g, '&');

/** A1 → [欄, 列]（0 起算）。 */
function refToRC(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) return null;
  let c = 0;
  for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64;
  return [c - 1, +m[2] - 1];
}

/**
 * 讀 .xlsx → [{ name, rows }]。
 *
 * 用規則式掃描而不是 DOM 解析：Node 沒有 DOMParser，而 Excel 產出的
 * 工作表 XML 結構非常規律（`<c r="A1" t="s"><v>5</v></c>`），掃得住。
 * 代價是不處理奇形怪狀的 XML —— 真的遇到就會少讀幾格，不會整份爆掉。
 */
export async function readWorkbook(buf) {
  const files = await unzip(buf);
  const dec = new TextDecoder('utf-8');
  const text = (n) => (files.has(n) ? dec.decode(files.get(n)) : '');

  const shared = [];
  const ss = text('xl/sharedStrings.xml');
  if (ss) {
    for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      shared.push([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => XTEXT(x[1])).join(''));
    }
  }

  const rels = new Map();
  for (const m of text('xl/_rels/workbook.xml.rels').matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    rels.set(m[1], m[2]);
  }
  const sheets = [];
  for (const m of text('xl/workbook.xml').matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = /name="([^"]*)"/.exec(m[1]);
    const rid = /r:id="([^"]*)"/.exec(m[1]);
    if (!name || !rid) continue;
    let tgt = rels.get(rid[1]) || '';
    tgt = tgt.replace(/^\/?xl\//, '').replace(/^\//, '');
    const path = `xl/${tgt}`;
    if (!files.has(path)) continue;
    sheets.push({ name: XTEXT(name[1]), rows: parseSheet(dec.decode(files.get(path)), shared) });
  }
  return sheets;
}

function parseSheet(xml, shared) {
  const cells = new Map();
  let maxR = -1, maxC = -1;
  for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = m[1], body = m[2] || '';
    const ref = /r="([A-Z]+\d+)"/.exec(attrs);
    if (!ref) continue;
    const rc = refToRC(ref[1]);
    if (!rc) continue;
    const t = /t="([^"]*)"/.exec(attrs);
    let val = '';
    if (t && t[1] === 'inlineStr') {
      val = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => XTEXT(x[1])).join('');
    } else {
      const v = /<v>([\s\S]*?)<\/v>/.exec(body);
      if (v) {
        val = t && t[1] === 's' ? (shared[+v[1]] ?? '') : XTEXT(v[1]);
      }
    }
    if (val === '') continue;
    cells.set(`${rc[1]}:${rc[0]}`, val);
    if (rc[1] > maxR) maxR = rc[1];
    if (rc[0] > maxC) maxC = rc[0];
  }
  const rows = [];
  for (let r = 0; r <= maxR; r++) {
    const row = [];
    for (let c = 0; c <= maxC; c++) row.push(cells.get(`${r}:${c}`) ?? '');
    rows.push(row);
  }
  return rows;
}
