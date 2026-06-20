const FALLBACK = require('../../public/data/market-seed.json');

const REDIS_KEY = 'summitwarroom:market:data';
const FX_FALLBACK_RATE = Number(process.env.FX_FALLBACK_USD_TWD || 31.60);
const FX_PRIMARY_URL = process.env.FX_API_URL || 'https://open.er-api.com/v6/latest/USD';
const FX_SECONDARY_URL = 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=TWD';

function pct(price, previousPrice) {
  const p = Number(price);
  const prev = Number(previousPrice);
  if (!Number.isFinite(p) || !Number.isFinite(prev) || prev === 0) return 0;
  return Number((((p - prev) / prev) * 100).toFixed(1));
}

function signal(changePct) {
  if (changePct > 3) return 'red';
  if (changePct > 1) return 'orange';
  if (changePct < -1) return 'green';
  return 'neutral';
}

function dir(changePct) {
  if (changePct > 0) return 'up';
  if (changePct < 0) return 'down';
  return 'flat';
}

function normalize(raw) {
  const items = (raw.items || []).map((x) => {
    const changePct = Number.isFinite(Number(x.changePct)) ? Number(x.changePct) : pct(x.price, x.previousPrice);
    return {
      id: x.id,
      zh: x.zh,
      en: x.en,
      unit: x.unit,
      price: Number(x.price),
      previousPrice: Number.isFinite(Number(x.previousPrice)) ? Number(x.previousPrice) : null,
      changePct,
      dir: x.dir || dir(changePct),
      signal: x.signal || signal(changePct),
      read: x.read || '',
      history: Array.isArray(x.history) ? x.history.map(Number).filter(Number.isFinite).slice(-12) : []
    };
  });
  return {
    updatedAt: new Date().toISOString(),
    mode: raw.mode || 'monthly-source',
    sourceUpdatedAt: raw.updatedAt || null,
    note: raw.note || '',
    items
  };
}

async function redisSet(key, value) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('Missing KV_REST_API_URL / KV_REST_API_TOKEN. Connect Upstash Redis in Vercel Marketplace.');
  const encoded = encodeURIComponent(JSON.stringify(value));
  const r = await fetch(`${url}/set/${encodeURIComponent(key)}/${encoded}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) throw new Error(`Redis set failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function redisGet(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store'
  });
  if (!r.ok) return null;
  const j = await r.json();
  if (!j || j.result == null) return null;
  return typeof j.result === 'string' ? JSON.parse(j.result) : j.result;
}

async function fetchSource(req) {
  const envSource = process.env.MARKET_SOURCE_URL;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const localSource = `${proto}://${host}/data/market-source.json`;
  const sourceUrl = envSource || localSource;
  const r = await fetch(sourceUrl, { cache: 'no-store' });
  if (!r.ok) throw new Error(`Source fetch failed: ${r.status} ${sourceUrl}`);
  return { sourceUrl, raw: await r.json() };
}

function extractRateFromPayload(j, url) {
  if (!j) return null;
  // open.er-api.com/v6/latest/USD => rates.TWD
  if (j.rates && (j.rates.TWD || j.rates.twd)) {
    return { rate: Number(j.rates.TWD || j.rates.twd), date: j.time_last_update_utc || j.date || null, source: url };
  }
  // alternative API shapes
  if (j.conversion_rates && (j.conversion_rates.TWD || j.conversion_rates.twd)) {
    return { rate: Number(j.conversion_rates.TWD || j.conversion_rates.twd), date: j.time_last_update_utc || j.date || null, source: url };
  }
  return null;
}

async function tryFetchFx(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`FX fetch failed: ${r.status} ${url}`);
  const j = await r.json();
  const fx = extractRateFromPayload(j, url);
  if (!fx || !Number.isFinite(fx.rate) || fx.rate <= 0) throw new Error(`FX API returned invalid USD/TWD rate: ${url}`);
  return { rate: Number(fx.rate.toFixed(2)), date: fx.date, source: fx.source };
}

async function fetchUsdTwdRate() {
  const errors = [];
  for (const url of [FX_PRIMARY_URL, FX_SECONDARY_URL]) {
    try { return await tryFetchFx(url); }
    catch (e) { errors.push(String(e && e.message ? e.message : e)); }
  }
  return {
    rate: Number(FX_FALLBACK_RATE.toFixed(2)),
    date: null,
    source: 'manual-fallback:FX_FALLBACK_USD_TWD',
    warning: errors.join(' | ')
  };
}

function updateFxItem(data, fx, previousData) {
  const fxRate = Number(fx && fx.rate);
  if (!Number.isFinite(fxRate) || fxRate <= 0) return data;

  const items = data.items.map((item) => {
    if (item.id !== 'fx') return item;

    const previousFx = previousData && Array.isArray(previousData.items)
      ? previousData.items.find((x) => x.id === 'fx')
      : null;

    // Avoid using the old wrong 32.74 as baseline; prefer source previousPrice.
    const sourcePrev = Number.isFinite(Number(item.previousPrice)) ? Number(item.previousPrice) : 31.55;
    const previousPrice = sourcePrev;

    const changePct = pct(fxRate, previousPrice);
    const baseHistory = Array.isArray(item.history) && item.history.length
      ? item.history.map(Number).filter(Number.isFinite).slice(-11)
      : [31.2,31.4,31.5,31.6,31.5,31.7,31.6,31.5,31.6,31.7,31.6].slice(-11);
    baseHistory.push(Number(fxRate));

    return {
      ...item,
      price: Number(fxRate.toFixed(2)),
      previousPrice: Number(previousPrice.toFixed(2)),
      changePct,
      dir: dir(changePct),
      signal: signal(changePct),
      read: fx.source && fx.source.startsWith('manual-fallback')
        ? '匯率外部來源暫時無法讀取，暫以31.60作為保守備援值；正式報告仍應以銀行牌告或成交匯率校正。'
        : '美元兌台幣每月自動更新；若台幣轉弱，進口採購成本壓力上升。',
      history: baseHistory
    };
  });

  return {
    ...data,
    mode: 'monthly-source',
    fxUpdatedAt: new Date().toISOString(),
    fxSource: fx.source,
    fxSourceDate: fx.date,
    fxWarning: fx.warning || null,
    items
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (process.env.CRON_SECRET) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ ok: false, error: 'Unauthorized cron request' });
  }

  try {
    const previousData = await redisGet(REDIS_KEY);
    const { sourceUrl, raw } = await fetchSource(req);
    let data = normalize(raw);

    const fx = await fetchUsdTwdRate();
    data = updateFxItem(data, fx, previousData);

    await redisSet(REDIS_KEY, data);
    res.status(200).json({
      ok: true,
      updatedAt: data.updatedAt,
      sourceUrl,
      count: data.items.length,
      fxRate: fx.rate,
      fxSource: fx.source,
      fxSourceDate: fx.date,
      fxWarning: fx.warning || null
    });
  } catch (err) {
    const fallback = normalize(FALLBACK);
    const fx = { rate: FX_FALLBACK_RATE, source: 'manual-fallback:catch' };
    const safeFallback = updateFxItem(fallback, fx, null);
    try { await redisSet(REDIS_KEY, safeFallback); } catch (_) {}
    res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err), fallbackCount: safeFallback.items.length });
  }
};
