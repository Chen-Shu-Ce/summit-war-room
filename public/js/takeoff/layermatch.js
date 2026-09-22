/**
 * 圖層 → 工項的自動對應。
 *
 * 為什麼這件事值得單獨寫一個模組：
 *
 * 向量圖（DXF／DWG）的量**本來就是自動的** —— 圖層裡每條線的長度是精確數字，
 * 加總起來不需要任何推論。真正卡住「自動抓量」的從來不是量測，是**對應**：
 * 這個叫 `E-TRAY-600` 的圖層，對到清單上哪一個工項？
 *
 * 原本的作法是「圖層名稱含有預先寫好的關鍵字」。它有兩個問題：
 *
 *   1. 換一個設計單位、換一套圖層命名，關鍵字就全部落空。
 *   2. **更嚴重**：兩個工項可以共用同一個關鍵字。範本裡 321.01（38mm² 電纜）
 *      和 321.02（22mm² 電纜）的 layerHints 都是 `E-CABLE-PWR` ——
 *      原本的作法會安靜地挑先出現的那一個，把整個圖層的長度塞給它。
 *      另一個工項的量變成 0，而畫面上不會有任何異狀。
 *
 * 所以這個模組的重點不是「猜得更準」，是**猜不準的時候要說出來**。
 * 分數低就不自動選，同分就標成無法分辨並把候選都列出來，讓人決定。
 *
 * 全部是可解釋的規則，不是模型：每一分都附一句理由，稽核時答得出
 * 「為什麼這個圖層被算到這個工項」。這一點比準確率更重要 ——
 * 對應錯了會被發現（單位不合、量級離譜），對應錯得沒有理由才是查不下去。
 */

/** 幾何型態 → 適合的 measureType。圖層只有圖塊就不可能是長度工項。 */
const GEOM_FIT = {
  length: (g) => g.length > 0,
  area: (g) => g.area > 0 && g.closedCount > 0,
  count: (g) => Object.keys(g.blocks || {}).length > 0 || ((g.types || {}).POINT || 0) > 0,
  volume: (g) => g.area > 0 || g.length > 0,
  weight: (g) => g.length > 0 || g.count > 0,
  lumpsum: () => true,
};

const SEP = /[^A-Za-z0-9一-鿿]+/;

/**
 * 切成可比對的詞。
 *
 * 英數依分隔符與大小寫邊界切；中文沒有詞界，切成 2-gram ——
 * 「電纜架」會產生「電纜」「纜架」，兩個都命中「電纜架 (Cable Tray)」。
 * 用整串比對的話，「電纜」對「電纜架」就會落空。
 */
export function tokens(s) {
  const out = new Set();
  for (const part of String(s || '').split(SEP)) {
    if (!part) continue;
    const cjk = part.replace(/[^一-鿿]/g, '');
    const latin = part.replace(/[一-鿿]/g, '');
    if (latin) {
      // camelCase 與連續數字都切開：CableTray600 → cable, tray, 600
      for (const w of latin.split(/(?<=[a-z])(?=[A-Z])|(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])/)) {
        if (w.length >= 2) out.add(w.toLowerCase());
      }
    }
    for (let i = 0; i + 2 <= cjk.length; i++) out.add(cjk.slice(i, i + 2));
    if (cjk.length === 1) out.add(cjk);
  }
  return out;
}

/** 規格裡的數字，用來比對圖層名稱帶的尺寸（E-TRAY-600 ↔ 600W×100H）。 */
export function numbersIn(s) {
  const out = new Set();
  for (const m of String(s || '').matchAll(/\d+(?:\.\d+)?/g)) {
    const n = m[0].replace(/\.0+$/, '');
    if (n.length >= 2) out.add(n);
  }
  return out;
}

/** CNS／JIS／ASTM 標準編號 —— 命中就幾乎是同一個東西。 */
export function standardsIn(s) {
  const out = new Set();
  for (const m of String(s || '').matchAll(/\b(CNS|JIS|ASTM|IEC|BS|DIN)\s*[-­]?\s*(\d{3,6})/gi)) {
    out.add(`${m[1].toUpperCase()}${m[2]}`);
  }
  return out;
}

export const WEIGHTS = {
  hintExact: 60,      // layerHints 與圖層名稱完全相同
  hintPrefix: 34,     // 圖層名稱以 hint 開頭（E-CABLE-PWR-1 ← E-CABLE-PWR）
  hintPart: 22,       // hint 出現在圖層名稱裡
  token: 9,           // 詞命中工項名稱／規格
  number: 11,         // 尺寸數字命中規格
  standard: 20,       // 標準編號命中
  geomFit: 14,        // 幾何型態與 measureType 相符
};

/** 自動採用的門檻。低於這個分數寧可留白，讓人自己選。 */
export const ACCEPT = 30;
/** 前兩名差距在這個比例內視為無法分辨。 */
export const TIE_RATIO = 0.15;

/**
 * 單一工項的得分。
 * g 是該圖層的幾何彙總（aggregateByLayer 的一列），可以不給。
 */
export function scoreItem(layer, item, g = null) {
  const L = String(layer || '');
  const low = L.toLowerCase();
  const reasons = [];
  let score = 0;

  let bestHint = 0;
  for (const h of item.layerHints || []) {
    const hh = String(h || '').toLowerCase();
    if (!hh) continue;
    let v = 0, how = '';
    if (low === hh) { v = WEIGHTS.hintExact; how = '完全相同'; }
    else if (low.startsWith(hh)) { v = WEIGHTS.hintPrefix + hh.length; how = '開頭相符'; }
    else if (low.includes(hh)) { v = WEIGHTS.hintPart + hh.length; how = '包含'; }
    if (v > bestHint) { bestHint = v; reasons.length = 0; reasons.push(`圖層關鍵字「${h}」${how}`); }
  }
  score += bestHint;

  const lt = tokens(L);
  const it = new Set([...tokens(item.name), ...tokens(item.spec), ...tokens(item.code)]);
  const hitTokens = [...lt].filter((t) => it.has(t));
  if (hitTokens.length) {
    score += Math.min(hitTokens.length, 4) * WEIGHTS.token;
    reasons.push(`名稱／規格詞命中：${hitTokens.slice(0, 4).join('、')}`);
  }

  const ln = numbersIn(L);
  const sn = numbersIn(`${item.spec} ${item.name}`);
  const hitNums = [...ln].filter((n) => sn.has(n));
  if (hitNums.length) {
    score += Math.min(hitNums.length, 2) * WEIGHTS.number;
    reasons.push(`規格尺寸命中：${hitNums.slice(0, 2).join('、')}`);
  }

  const hitStd = [...standardsIn(L)].filter((x) => standardsIn(item.spec).has(x));
  if (hitStd.length) { score += WEIGHTS.standard; reasons.push(`標準編號命中：${hitStd.join('、')}`); }

  // 幾何型態不是扣分，是**否決**。
  //
  // 名稱對得再像，只要這個圖層產不出這個工項要的那種量，對應就是錯的：
  // 一個叫 E-LIGHT-HB、裡面只有線段沒有圖塊的圖層，對到計數工項「LED 高天井燈」，
  // 寫進去的會是「40 只」—— 那個 40 是線段條數，不是燈的數量。
  // 分數再高也不該自動採用，所以標成 blocked 而不是減分。
  //
  // 反過來，名稱完全沒對上時不可以因為「圖層裡剛好有線段」就加分 ——
  // 那會讓每一個圖層都配到某個工項。所以先要有文字證據才看幾何。
  let blocked = false;
  if (g && score > 0) {
    const fit = GEOM_FIT[item.measureType || 'length'];
    if (fit && fit(g)) { score += WEIGHTS.geomFit; reasons.push(`幾何型態相符（${item.measureType}）`); }
    else if (fit) { blocked = true; reasons.push(`幾何型態不符：此工項要 ${item.measureType}，該圖層產不出這種量`); }
  }

  return { code: item.code, score: Math.max(0, Math.round(score)), reasons, blocked };
}

/**
 * 對一個圖層挑工項。
 *
 * 回傳一定包含 `ambiguous` —— 前兩名太接近時**不自動選**。
 * 範本裡 321.01 與 321.02 共用 `E-CABLE-PWR` 就是這種情形：
 * 一條線在幾何上看不出來是 38mm² 還是 22mm²，這是圖面本身沒有這個資訊，
 * 不是演算法不夠聰明。硬選一個只會把整個圖層的長度算到其中一個工項頭上。
 */
export function match(layer, items, g = null) {
  const scored = items.map((it) => scoreItem(layer, it, g))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  // 被幾何否決的仍留在 all 裡（連同理由），只是不參與自動選取 ——
  // 使用者要看得到「它有對到名稱，但幾何不對」，而不是憑空消失。
  const usable = scored.filter((x) => !x.blocked);
  if (!usable.length) {
    return { best: null, top: null, score: 0, band: scored.length ? 'blocked' : 'none',
      ambiguous: [], reasons: scored.length ? scored[0].reasons : [], all: scored.slice(0, 5) };
  }

  const top = usable[0];
  const rivals = usable.filter((x) => x !== top && x.score >= top.score * (1 - TIE_RATIO));
  const band = top.score >= ACCEPT * 2 ? 'high' : top.score >= ACCEPT ? 'mid' : 'low';
  return {
    best: rivals.length || band === 'low' ? null : top.code,
    top: top.code,
    score: top.score,
    band,
    ambiguous: rivals.length ? [top.code, ...rivals.map((x) => x.code)] : [],
    reasons: top.reasons,
    all: scored.slice(0, 5),
  };
}

/** 一句話說明這次對應的結果，直接放在畫面上。 */
export function explain(m, nameOf = (c) => c) {
  if (!m.best && m.ambiguous.length) {
    return `無法分辨：${m.ambiguous.map(nameOf).join(' / ')} 分數相近，幾何上看不出差別，請人工指定`;
  }
  if (!m.best && m.band === 'blocked') return m.reasons.join('；') || '幾何型態不符，未自動對應';
  if (!m.best && m.band === 'low') return `相似度不足（${m.score}），未自動對應`;
  if (!m.best) return '找不到對應的工項';
  return `${m.reasons.join('；')}（分數 ${m.score}）`;
}
