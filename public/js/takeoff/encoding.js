/**
 * encoding.js — DXF 文字編碼偵測與解碼（純函式，無 DOM、無 I/O）
 *
 * 台灣的 DXF 幾乎都是 Big5（`$DWGCODEPAGE = ANSI_950`），大陸的多半是 GBK（ANSI_936）。
 * 把整個檔案當 UTF-8 解，每一個中文字都會變成 U+FFFD —— 畫面上就是那一整排 ????。
 *
 * 這不是「缺字型」。缺字型是 CAD 端找不到 SHX 大字型檔的現象；
 * 這裡是**解碼器選錯**，而且完全可以修好。兩者畫面長得一樣，成因完全不同：
 *
 *   缺 SHX 大字型 → 讀得到位元組，但畫不出字形 → 顯示 ? 或方框，換字型就好
 *   解碼器選錯     → 位元組被錯誤詮釋 → 字直接不存在了，換字型無效
 *
 * 判斷順序：
 *   1. R2007（AC1021）以後的 DXF 一律 UTF-8，不看 $DWGCODEPAGE。
 *   2. 讀 $DWGCODEPAGE 指定的編碼 —— 但要跟其他候選比過分數才採信。
 *   3. 宣告不可信或沒有宣告，就用評分挑，並明白回報這是推測的。
 */

/** AutoCAD 的 $DWGCODEPAGE 名稱 → WHATWG Encoding 名稱。 */
export const CODEPAGES = {
  ANSI_874: 'windows-874',
  ANSI_932: 'shift_jis',
  ANSI_936: 'gbk',
  ANSI_949: 'euc-kr',
  ANSI_950: 'big5',
  ANSI_1250: 'windows-1250', ANSI_1251: 'windows-1251', ANSI_1252: 'windows-1252',
  ANSI_1253: 'windows-1253', ANSI_1254: 'windows-1254', ANSI_1255: 'windows-1255',
  ANSI_1256: 'windows-1256', ANSI_1257: 'windows-1257', ANSI_1258: 'windows-1258',
  UTF8: 'utf-8', 'UTF-8': 'utf-8',
};

/** $ACADVER → 版本名。AC1021（R2007）起 DXF 內容一律 UTF-8。 */
export const ACAD_VERSIONS = {
  AC1006: 'R10', AC1009: 'R11/R12', AC1012: 'R13', AC1014: 'R14',
  AC1015: 'AutoCAD 2000', AC1018: 'AutoCAD 2004', AC1021: 'AutoCAD 2007',
  AC1024: 'AutoCAD 2010', AC1027: 'AutoCAD 2013', AC1032: 'AutoCAD 2018',
};

const UTF8_FROM = ['AC1021', 'AC1024', 'AC1027', 'AC1032'];

/** 宣告編碼要輸這麼多分才會被推翻。門檻不低，避免為了幾個字就不信檔案自己說的話。 */
const DECLARE_MARGIN = 30;

/** 自動偵測時的候選順序：台灣現場最常見的排前面。 */
export const CANDIDATES = ['utf-8', 'big5', 'gbk', 'shift_jis', 'euc-kr', 'windows-1252'];

const FFFD = 0xFFFD;

function toBytes(buf) {
  if (buf instanceof Uint8Array) return buf;
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  if (buf && buf.buffer) return new Uint8Array(buf.buffer, buf.byteOffset || 0, buf.byteLength);
  return new Uint8Array(buf);
}

/** 以 windows-1252 掃描檔頭，取出 $ACADVER 與 $DWGCODEPAGE。這兩個值本身一定是 ASCII。 */
export function sniffHeader(buf, limit = 65536) {
  const bytes = toBytes(buf);
  const head = new TextDecoder('windows-1252').decode(bytes.slice(0, Math.min(limit, bytes.length)));
  const grab = (name, code) => {
    const re = new RegExp('\\$' + name + '\\s*[\\r\\n]+\\s*' + code + '\\s*[\\r\\n]+\\s*([^\\r\\n]+)');
    const m = head.match(re);
    return m ? m[1].trim() : null;
  };
  const acadver = grab('ACADVER', 1);
  const codepage = grab('DWGCODEPAGE', 3);
  return { acadver, codepage, version: acadver ? (ACAD_VERSIONS[acadver] || acadver) : null };
}

const isIdeograph = (c) => (c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3400 && c <= 0x4DBF);
const isCjkPunct = (c) => (c >= 0x3000 && c <= 0x303F) || (c >= 0xFF01 && c <= 0xFF5E) || c === 0x33A1;
const isHalfKana = (c) => c >= 0xFF61 && c <= 0xFF9F;
const isHighLatin = (c) => c >= 0xA0 && c <= 0xFF;
const isC1 = (c) => c >= 0x80 && c <= 0x9F;

/**
 * 解碼品質評分。
 *
 * 關鍵是**獎勵連續的漢字，不是單一漢字**：真實中文詞彙至少兩個字連著，
 * 而解碼錯誤產生的是散落的孤字。只數漢字總數的話，
 * 用 Shift-JIS 解 Big5 會得到一堆半形片假名夾雜孤立漢字，分數反而爆高。
 *
 * 兩種誤解的指紋各自重扣：
 *   半形片假名連串  → 把中文當日文解
 *   高位拉丁字連串  → 把雙位元組當單位元組解（¤¤¤å）
 *   U+FFFD／C1     → 根本解不出來
 */
export function scoreText(text) {
  let runIdeo = 0, isolated = 0, punct = 0, bad = 0, c1 = 0, kana = 0, latin = 0, ascii = 0;
  let ideoRun = 0, latinRun = 0, kanaRun = 0;
  const flushIdeo = () => {
    if (ideoRun >= 2) runIdeo += ideoRun; else isolated += ideoRun;
    ideoRun = 0;
  };
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (isIdeograph(c)) { ideoRun++; latinRun = 0; kanaRun = 0; continue; }
    flushIdeo();
    if (isHighLatin(c)) { latinRun++; if (latinRun >= 2) latin++; kanaRun = 0; continue; }
    latinRun = 0;
    if (isHalfKana(c)) { kanaRun++; if (kanaRun >= 2) kana++; continue; }
    kanaRun = 0;
    if (c === FFFD) { bad++; continue; }
    if (isC1(c)) { c1++; continue; }
    if (isCjkPunct(c)) { punct++; continue; }
    if (c < 0x80) ascii++;
  }
  flushIdeo();
  const score = runIdeo * 4 + isolated * 1 + punct * 2 - bad * 12 - c1 * 12 - kana * 6 - latin * 5;
  return { score, runIdeo, isolated, punct, bad, c1, kana, latin, ascii, cjk: runIdeo + isolated };
}

/**
 * 解一份 DXF。回傳文字，以及「怎麼決定的」——
 * 來源必須可追，因為猜錯編碼跟缺字型的畫面一模一樣，使用者需要知道是哪一種。
 */
export function decodeDxf(buf) {
  const bytes = toBytes(buf);
  const hdr = sniffHeader(bytes);
  const tried = [];
  const cache = new Map();

  const tryEnc = (enc) => {
    if (cache.has(enc)) return cache.get(enc);
    let r = null;
    try {
      const text = new TextDecoder(enc, { fatal: false }).decode(bytes);
      r = { text, encoding: enc, ...scoreText(text) };
      const { text: _omit, ...log } = r;
      tried.push(log);
    } catch {
      tried.push({ encoding: enc, score: -Infinity, unsupported: true });
    }
    cache.set(enc, r);
    return r;
  };

  // 0) 全部都是 ASCII → 每一種候選解出來都一模一樣，沒有什麼好判的。
  //    這種檔案不該跳出「編碼可能有誤」的警告去嚇人。
  let pureAscii = true;
  for (let i = 0; i < bytes.length; i++) { if (bytes[i] > 0x7F) { pureAscii = false; break; } }
  if (pureAscii) {
    const text = new TextDecoder('utf-8').decode(bytes);
    return { text, encoding: 'utf-8', from: 'ascii', ...hdr, tried: [], confident: true, pureAscii: true, ...scoreText(text) };
  }

  // 1) R2007 以後一律 UTF-8，檔頭宣告的 codepage 不作數
  if (hdr.acadver && UTF8_FROM.includes(hdr.acadver)) {
    const r = tryEnc('utf-8');
    if (r) return { ...r, from: 'acadver', ...hdr, encoding: 'utf-8', tried, confident: true };
  }

  // 先把所有候選都跑過，宣告的編碼才有東西可比
  let best = null;
  for (const enc of CANDIDATES) {
    const r = tryEnc(enc);
    if (r && (!best || r.score > best.score)) best = r;
  }

  // 2) 檔案自己宣告的編碼 —— 但必須通過挑戰。
  //
  //    只檢查「有沒有替代字元」是不夠的：windows-1252 這種單位元組編碼
  //    幾乎每個位元組都對應得到字，把 Big5 內容解成 ¤¤¤å 一個 U+FFFD 都不會產生。
  //    轉檔工具改了內容卻沒改檔頭是常態，所以宣告值必須接受挑戰。
  const declared = hdr.codepage ? CODEPAGES[hdr.codepage.toUpperCase()] : null;
  if (declared) {
    const d = tryEnc(declared);
    if (d && (!best || d.score >= best.score - DECLARE_MARGIN)) {
      return { ...d, from: 'codepage', ...hdr, encoding: declared, tried, confident: true };
    }
  }

  // 3) 宣告不可信或根本沒宣告 → 用評分挑，並明白標示是推測的
  if (!best) {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    return { text, encoding: 'utf-8', from: 'fallback', ...hdr, tried, confident: false, ...scoreText(text) };
  }
  return {
    ...best, from: declared ? 'guess-after-bad-codepage' : 'guess',
    ...hdr, encoding: best.encoding, tried, confident: false,
  };
}

/* ────────── TEXT / MTEXT 內容碼 ────────── */

/**
 * 把 MTEXT 的排版控制碼與跳脫序列還原成純文字。
 *
 * AutoCAD 把字型、字高、寬度、堆疊分數都混在文字裡：
 *   {\fMSungGBK|b0|i0|c134|p2;走廊面積}   \H2.5x;   \W0.8;   \P   \U+4E2D   %%c
 * 不處理的話，工項名稱會混進一堆 `\f...|b0|i0` 的雜訊。
 */
export function decodeMText(raw) {
  let s = String(raw ?? '');
  if (!s) return s;
  // \U+XXXX 與 \M+XXXXX Unicode 跳脫
  s = s.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  s = s.replace(/\\M\+[0-9A-Fa-f]([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  // 堆疊分數 \S上^下; → 上/下
  s = s.replace(/\\S([^;]*);/g, (_, body) => body.replace(/[\^#]/, '/'));
  // 段落與不斷行空白
  s = s.replace(/\\P/g, '\n').replace(/\\~/g, ' ');
  // 帶參數的控制碼：字型 F/f、字高 H、寬度 W、色彩 C、傾斜 Q、追蹤 T、對齊 A、段落 p
  s = s.replace(/\\[fFHWCQTAp][^\\;]*;/g, '');
  // 無參數控制碼（底線、上劃線、遮罩等）
  s = s.replace(/\\[LlOoKkNnX]/g, '');
  // 群組括號：跳脫過的 \{ \} 要保留，這裡只去掉未跳脫的
  s = s.replace(/(^|[^\\])[{}]/g, '$1');
  s = s.replace(/^[{}]/, '');
  // 跳脫字元還原
  s = s.replace(/\\\\/g, '\\').replace(/\\\{/g, '{').replace(/\\\}/g, '}');
  // %% 特殊符號
  s = s.replace(/%%[dD]/g, '°').replace(/%%[cC]/g, 'Ø').replace(/%%[pP]/g, '±');
  s = s.replace(/%%%/g, '%').replace(/%%[uUoO]/g, '');
  return s.trim();
}

/**
 * 這段文字是不是解碼壞掉了。
 *
 * 跟 calcsheet 的 isMojibake 不同：那個看「一堆問號」（CAD 缺字型的產物），
 * 這個看 U+FFFD 與 C1 控制碼（解碼器選錯的產物）。成因不同，處方也不同。
 */
export function looksMisdecoded(text) {
  const s = String(text ?? '');
  if (!s) return false;
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c === FFFD || isC1(c)) n++;
  }
  return n > 0 && n / s.length >= 0.1;
}

/** 給使用者看的一句話結論。 */
export function describe(info) {
  if (!info) return '';
  const enc = info.encoding || '—';
  const ver = info.version || '版本未標示';
  if (info.from === 'ascii') return `${ver}：檔案全部是 ASCII，沒有需要判斷的編碼。`;
  if (info.from === 'acadver') return `${ver}：R2007 以後的 DXF 一律 UTF-8，已依此解碼。`;
  if (info.from === 'codepage') return `${ver}：檔頭宣告 ${info.codepage}，已用 ${enc} 解碼。`;
  if (info.from === 'guess-after-bad-codepage') {
    return `${ver}：檔頭宣告 ${info.codepage}，但用它解出來的內容不像正常文字（轉檔工具常沒改檔頭），改以 ${enc} 解碼 —— 這是推測的，請核對中文是否正確。`;
  }
  if (info.from === 'guess') return `${ver}：檔頭沒有宣告編碼，依內容推測為 ${enc} —— 這是推測的，請核對中文是否正確。`;
  return `${ver}：以 ${enc} 解碼。`;
}
