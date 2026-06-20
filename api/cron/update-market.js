const FALLBACK = require('../../public/data/market-seed.json');

const REDIS_KEY = 'summitwarroom:market:data';
const FX_API_URL = process.env.FX_API_URL || 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=TWD';

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
      dir: dir(changePct),
      signal: signal(changePct),
      read: x.read || '',
      history: Array.isArray(x.history) ? x.history.map(Number).slice(-12) : []
    };
  });
  return {
    updatedAt: new Date().toISOString(),
    mode: raw.mode || 'vercel-cron',
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

async function fetchUsdTwdRate() {
  const r = await fetch(FX_API_URL, { cache: 'no-store' });
  if (!r.ok) throw new Error(`FX fetch failed: ${r.status}`);
  const j = await r.json();
  const rawRate = j && j.rates && (j.rates.TWD || j.rates.twd);
  const rate = Number(rawRate);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('FX API returned invalid USD/TWD rate');
  return { rate: Number(rate.toFixed(2)), date: j.date || null, source: FX_API_URL };
}

function updateFxItem(data, fx, previousData) {
  if (!fx || !Number.isFinite(Number(fx.rate))) return data;
  const items = data.items.map((item) => {
    if (item.id !== 'fx') return item;

    const previousFx = previousData && Array.isArray(previousData.items)
      ? previousData.items.find((x) => x.id === 'fx')
      : null;

    const previousPrice = Number.isFinite(Number(previousFx && previousFx.price))
      ? Number(previousFx.price)
      : (Number.isFinite(Number(item.previousPrice)) ? Number(item.previousPrice) : Number(item.price));

    const changePct = pct(fx.rate, previousPrice);
    const nextHistory = Array.isArray(item.history) ? item.history.slice(-11) : [];
    nextHistory.push(Number(fx.rate));

    return {
      ...item,
      price: Number(fx.rate),
      previousPrice: Number(previousPrice.toFixed(2)),
      changePct,
      dir: dir(changePct),
      signal: signal(changePct),
      read: '美元兌台幣每月自動更新；若台幣轉弱，進口採購成本壓力上升。',
      history: nextHistory
    };
  });

  return {
    ...data,
    mode: 'monthly-source',
    fxUpdatedAt: new Date().toISOString(),
    fxSource: fx.source,
    fxSourceDate: fx.date,
    items
  };
}

module.exports = async function handler(req, res) {
  if (process.env.CRON_SECRET) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ ok: false, error: 'Unauthorized cron request' });
  }

  try {
    const previousData = await redisGet(REDIS_KEY);
    const { sourceUrl, raw } = await fetchSource(req);
    let data = normalize(raw);

    let fx = null;
    let fxWarning = null;
    try {
      fx = await fetchUsdTwdRate();
      data = updateFxItem(data, fx, previousData);
    } catch (fxErr) {
      fxWarning = String(fxErr && fxErr.message ? fxErr.message : fxErr);
    }

    await redisSet(REDIS_KEY, data);
    res.status(200).json({
      ok: true,
      updatedAt: data.updatedAt,
      sourceUrl,
      count: data.items.length,
      fxRate: fx ? fx.rate : null,
      fxSourceDate: fx ? fx.date : null,
      fxWarning
    });
  } catch (err) {
    const fallback = normalize(FALLBACK);
    try { await redisSet(REDIS_KEY, fallback); } catch (_) {}
    res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err), fallbackCount: fallback.items.length });
  }
};

