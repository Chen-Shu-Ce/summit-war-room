# Summit Warroom Vercel Cron v8

This version places the homepage at `public/index.html` because the current Vercel project is serving static assets from `public/`.

Required structure:

- `public/index.html` — homepage
- `public/data/market-source.json` — monthly market source data
- `public/data/market-seed.json` — fallback data
- `api/market-data.js` — frontend market data API
- `api/cron/update-market.js` — monthly cron update API
- `vercel.json` — homepage rewrite + monthly cron
- `package.json` — project metadata

After committing to GitHub, Vercel should redeploy automatically.
Test:

- https://www.summitwarroom.com/
- https://www.summitwarroom.com/index.html
- https://www.summitwarroom.com/api/market-data
- https://www.summitwarroom.com/api/cron/update-market
