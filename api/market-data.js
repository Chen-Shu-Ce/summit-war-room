const FALLBACK = require('../public/data/market-seed.json');

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

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  try {
    const data = await redisGet('summitwarroom:market:data');
    res.status(200).json(data || FALLBACK);
  } catch (err) {
    res.status(200).json({ ...FALLBACK, mode: 'fallback', error: String(err && err.message ? err.message : err) });
  }
};


