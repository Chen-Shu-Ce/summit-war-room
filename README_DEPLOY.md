# Summit War Room — Vercel Cron 自動更新版

## 功能
- `/api/market-data`：網站讀取最新市場情報資料。
- `/api/cron/update-market`：Vercel Cron 每月自動更新資料。
- `vercel.json`：設定每月 5 日 01:00 UTC 執行；台灣時間約每月 5 日 09:00。
- `public/data/market-source.json`：資料來源範本。

## 必要設定
1. 在 Vercel 專案連接 Upstash Redis Marketplace。
2. 確認 Vercel Environment Variables 已有：
   - `KV_REST_API_URL`
   - `KV_REST_API_TOKEN`
3. 可選：設定 `MARKET_SOURCE_URL`，指向你的正式市場資料 JSON。
4. 可選：設定 `CRON_SECRET` 保護手動呼叫 cron endpoint。

## 部署
1. 將整包 ZIP 解壓縮。
2. 上傳到 GitHub repository。
3. Vercel 匯入該 repository。
4. Domains 加入 `summitwarroom.com`。
5. 部署完成後，手動測試：
   - `https://summitwarroom.com/api/market-data`
   - `https://summitwarroom.com/api/cron/update-market`

## 資料格式
請參考 `public/data/market-source.json`。
每個指標至少需要：
- id
- zh
- en
- unit
- price
- previousPrice 或 changePct
- read
- history：最近 12 個月數值

