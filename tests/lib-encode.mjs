/**
 * lib-encode.mjs — 測試用的 Big5 / GBK 編碼器（零相依）。
 *
 * Node 只內建「解碼」（TextDecoder），沒有內建這些編碼的「編碼器」。
 * 這裡用解碼器把所有雙位元組組合跑一遍，反建出「字 → 位元組」對照表。
 * 只在測試裡用，正式程式不需要編碼、只需要解碼。
 */

const CONFIG = {
  big5: { lead: [0x81, 0xFE], trails: [[0x40, 0x7E], [0xA1, 0xFE]] },
  gbk: { lead: [0x81, 0xFE], trails: [[0x40, 0x7E], [0x80, 0xFE]] },
};

const cache = new Map();

function buildTable(enc) {
  if (cache.has(enc)) return cache.get(enc);
  const cfg = CONFIG[enc];
  if (!cfg) throw new Error(`不支援的編碼：${enc}`);
  const dec = new TextDecoder(enc, { fatal: false });
  const map = new Map();
  const pair = new Uint8Array(2);
  for (let lead = cfg.lead[0]; lead <= cfg.lead[1]; lead++) {
    for (const [lo, hi] of cfg.trails) {
      for (let trail = lo; trail <= hi; trail++) {
        pair[0] = lead; pair[1] = trail;
        const s = dec.decode(pair);
        // 只收剛好解成單一非替代字元的組合，且以先出現者為準（與常用對照表一致）
        if (s.length === 1 && s.codePointAt(0) !== 0xFFFD && s.codePointAt(0) >= 0x80 && !map.has(s)) {
          map.set(s, [lead, trail]);
        }
      }
    }
  }
  cache.set(enc, map);
  return map;
}

/** 把字串編成指定編碼的 Buffer。編不出來的字會拋錯，不靜默丟掉。 */
export function encode(str, enc) {
  const map = buildTable(enc);
  const out = [];
  for (const ch of String(str)) {
    const c = ch.codePointAt(0);
    if (c < 0x80) { out.push(c); continue; }
    const bytes = map.get(ch);
    if (!bytes) throw new Error(`${enc} 編不出字元「${ch}」(U+${c.toString(16).toUpperCase()})`);
    out.push(bytes[0], bytes[1]);
  }
  return Buffer.from(out);
}

export default { encode };
