#!/bin/bash
# ════════════════════════════════════════════════════════════
# EPCOS V4 — 周邊功能端對端測試
# 預算、變更單、傳票、通知、稽核、單價、OCR、報表
# ════════════════════════════════════════════════════════════
set -e

BASE="http://localhost:3001/api/v1"
CT="Content-Type: application/json"

json_field() { python3 -c "import sys,json; print(json.load(sys.stdin)$1)"; }

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   EPCOS V4 周邊功能端對端測試            ║"
echo "╚══════════════════════════════════════════╝"

# ── Login ──
echo ""
echo "━━━ 登入 ━━━"
TOKEN=$(curl -sf -X POST "$BASE/auth/login" -H "$CT" -d '{"email":"wang@test.com"}' | json_field "['token']")
AUTH="Authorization: Bearer $TOKEN"
echo "  ✓ 王建民 (申請人)"

TOKEN_FIN=$(curl -sf -X POST "$BASE/auth/login" -H "$CT" -d '{"email":"huang@test.com"}' | json_field "['token']")
AUTH_FIN="Authorization: Bearer $TOKEN_FIN"
echo "  ✓ 黃美玲 (財務)"

TOKEN_ENG=$(curl -sf -X POST "$BASE/auth/login" -H "$CT" -d '{"email":"chen@test.com"}' | json_field "['token']")
AUTH_ENG="Authorization: Bearer $TOKEN_ENG"
echo "  ✓ 陳文茜 (工程主管)"

TOKEN_ADMIN=$(curl -sf -X POST "$BASE/auth/login" -H "$CT" -d '{"email":"wu@test.com"}' | json_field "['token']")
AUTH_ADMIN="Authorization: Bearer $TOKEN_ADMIN"
echo "  ✓ 吳宗憲 (系統管理)"

ENTITY_ID=$(curl -sf "$BASE/auth/entities" | json_field "[0]['id']")
PROJECT_ID="proj-sy-001"

# ═══════════════════════════════════════
# 1. 預算管理 (Budgets)
# ═══════════════════════════════════════
echo ""
echo "━━━ 1. 預算管理 ━━━"

# 查詢現有預算 (seed data)
BUDGET_COUNT=$(curl -sf "$BASE/budgets/project/$PROJECT_ID" -H "$AUTH" | json_field ".__len__()")
echo "  ✓ 查詢預算: $BUDGET_COUNT 筆類別"

# 預算可用性檢查
CHECK=$(curl -sf -X POST "$BASE/budgets/check" -H "$CT" -H "$AUTH" \
  -d "{\"projectId\":\"$PROJECT_ID\",\"category\":\"MATERIAL\",\"amount\":1000000}")
AVAIL=$(echo "$CHECK" | json_field "['available']")
echo "  ✓ 預算可用性: $AVAIL (材料 100萬)"

# 預算消耗
CONSUME=$(curl -sf -X POST "$BASE/budgets/consume" -H "$CT" -H "$AUTH" \
  -d "{\"projectId\":\"$PROJECT_ID\",\"category\":\"MATERIAL\",\"amount\":1400000}")
RATE=$(echo "$CONSUME" | json_field "['executionRate']")
ALERT=$(echo "$CONSUME" | json_field "['alertLevel']")
echo "  ✓ 消耗預算: 材料 140萬 → 執行率 $RATE% 警示 $ALERT"

# ═══════════════════════════════════════
# 2. 變更單 (Change Orders)
# ═══════════════════════════════════════
echo ""
echo "━━━ 2. 變更單 ━━━"

CO_RESP=$(curl -sf -X POST "$BASE/change-orders" -H "$CT" -H "$AUTH_ENG" \
  -d "{
    \"legalEntityId\":\"$ENTITY_ID\",
    \"projectId\":\"$PROJECT_ID\",
    \"title\":\"鋼筋數量追加\",
    \"reason\":\"結構變更需追加 10 噸\",
    \"originalAmount\":1400000,
    \"changeAmount\":280000,
    \"items\":[{\"name\":\"SD420 #8 鋼筋追加\",\"qty\":10,\"unit\":\"噸\",\"unitPrice\":28000}]
  }")
CO_ID=$(echo "$CO_RESP" | json_field "['id']")
CO_NUM=$(echo "$CO_RESP" | json_field "['docNumber']")
CO_NEW=$(echo "$CO_RESP" | json_field "['newAmount']")
echo "  ✓ 建立: $CO_NUM (原額+變更=$CO_NEW)"

# 送審
CO_SUBMIT=$(curl -sf -X POST "$BASE/change-orders/$CO_ID/submit" -H "$CT" -H "$AUTH_ENG")
echo "  ✓ 送審: $(echo "$CO_SUBMIT" | json_field "['status']")"

# 核准
CO_APPROVE=$(curl -sf -X POST "$BASE/change-orders/$CO_ID/approve" -H "$CT" -H "$AUTH_ENG")
echo "  ✓ 核准: $(echo "$CO_APPROVE" | json_field "['status']")"

# ═══════════════════════════════════════
# 3. 核心流程 + 自動傳票 (Voucher)
# ═══════════════════════════════════════
echo ""
echo "━━━ 3. 核心流程 (含自動傳票) ━━━"

# 快速跑一遍 SR→PR→PO→驗收→請款
SR=$(curl -sf -X POST "$BASE/site-requests" -H "$CT" -H "$AUTH" -H "Idempotency-Key: test-pf-sr-$(date +%s)" \
  -d "{\"legalEntityId\":\"$ENTITY_ID\",\"projectId\":\"$PROJECT_ID\",\"title\":\"水泥採購\",\"totalAmount\":500000}")
SR_ID=$(echo "$SR" | json_field "['id']")
curl -sf -X POST "$BASE/site-requests/$SR_ID/submit" -H "$CT" -H "$AUTH" > /dev/null
curl -sf -X POST "$BASE/site-requests/$SR_ID/approve" -H "$CT" -H "$AUTH_ENG" > /dev/null
PR=$(curl -sf -X POST "$BASE/site-requests/$SR_ID/convert-pr" -H "$CT" -H "$AUTH_ENG")
PR_ID=$(echo "$PR" | json_field "['id']")
echo "  ✓ SR→PR: $(echo "$PR" | json_field "['docNumber']")"

TOKEN_PROC=$(curl -sf -X POST "$BASE/auth/login" -H "$CT" -d '{"email":"li@test.com"}' | json_field "['token']")
AUTH_PROC="Authorization: Bearer $TOKEN_PROC"
TOKEN_PMGR=$(curl -sf -X POST "$BASE/auth/login" -H "$CT" -d '{"email":"zhang@test.com"}' | json_field "['token']")
AUTH_PMGR="Authorization: Bearer $TOKEN_PMGR"

curl -sf -X POST "$BASE/purchase-requests/$PR_ID/submit" -H "$CT" -H "$AUTH_PROC" > /dev/null
curl -sf -X POST "$BASE/purchase-requests/$PR_ID/approve" -H "$CT" -H "$AUTH_PMGR" > /dev/null
PO=$(curl -sf -X POST "$BASE/purchase-requests/$PR_ID/convert-po" -H "$CT" -H "$AUTH_PMGR")
PO_ID=$(echo "$PO" | json_field "['id']")
echo "  ✓ PR→PO: $(echo "$PO" | json_field "['docNumber']")"

curl -sf -X POST "$BASE/purchase-orders/$PO_ID/submit" -H "$CT" -H "$AUTH_PMGR" > /dev/null
curl -sf -X POST "$BASE/purchase-orders/$PO_ID/approve" -H "$CT" -H "$AUTH_PMGR" > /dev/null
curl -sf -X POST "$BASE/purchase-orders/$PO_ID/issue" -H "$CT" -H "$AUTH_PMGR" > /dev/null
echo "  ✓ PO → ISSUED"

INSP=$(curl -sf -X POST "$BASE/inspections" -H "$CT" -H "$AUTH_ENG" -H "Idempotency-Key: test-pf-insp-$(date +%s)" \
  -d "{\"sourceId\":\"$PO_ID\",\"legalEntityId\":\"$ENTITY_ID\",\"projectId\":\"$PROJECT_ID\",\"title\":\"水泥驗收\",\"totalAmount\":500000}")
INSP_ID=$(echo "$INSP" | json_field "['id']")
curl -sf -X POST "$BASE/inspections/$INSP_ID/complete" -H "$CT" -H "$AUTH_ENG" > /dev/null
echo "  ✓ 驗收 COMPLETED"

PAY=$(curl -sf -X POST "$BASE/payment-claims" -H "$CT" -H "$AUTH_PROC" -H "Idempotency-Key: test-pf-pay-$(date +%s)" \
  -d "{\"sourceId\":\"$INSP_ID\",\"legalEntityId\":\"$ENTITY_ID\",\"projectId\":\"$PROJECT_ID\",\"title\":\"水泥請款\",\"totalAmount\":500000}")
PAY_ID=$(echo "$PAY" | json_field "['id']")
PAY_NUM=$(echo "$PAY" | json_field "['docNumber']")
curl -sf -X POST "$BASE/payment-claims/$PAY_ID/submit" -H "$CT" -H "$AUTH_PROC" > /dev/null

# 核准 → 自動產生傳票
PAY_APPROVE=$(curl -sf -X POST "$BASE/payment-claims/$PAY_ID/approve" -H "$CT" -H "$AUTH_FIN")
VOUCHER_NUM=$(echo "$PAY_APPROVE" | json_field "['voucher']['docNumber']")
VOUCHER_ID=$(echo "$PAY_APPROVE" | json_field "['voucher']['id']")
VOUCHER_STATUS=$(echo "$PAY_APPROVE" | json_field "['voucher']['status']")
echo "  ✓ 請款核准 → 自動傳票: $VOUCHER_NUM ($VOUCHER_STATUS)"

# 傳票確認
CONFIRM=$(curl -sf -X POST "$BASE/vouchers/$VOUCHER_ID/confirm" -H "$CT" -H "$AUTH_FIN" \
  -d '{"debitAccount":"2102-應付帳款","creditAccount":"1101-銀行存款"}')
CONFIRM_STATUS=$(echo "$CONFIRM" | json_field "['status']")
echo "  ✓ 傳票確認: $CONFIRM_STATUS"

# ═══════════════════════════════════════
# 4. 通知 (Notifications)
# ═══════════════════════════════════════
echo ""
echo "━━━ 4. 通知 ━━━"

NOTIF=$(curl -sf -X POST "$BASE/notifications/send" -H "$CT" -H "$AUTH_ADMIN" \
  -d '{"userId":"user-01","type":"SYSTEM","title":"系統公告","body":"EPCOS V4 周邊功能測試中"}')
NOTIF_ID=$(echo "$NOTIF" | json_field "['id']")
echo "  ✓ 發送通知: $NOTIF_ID"

# 查詢通知
NOTIF_LIST=$(curl -sf "$BASE/notifications" -H "$AUTH")
UNREAD=$(echo "$NOTIF_LIST" | json_field "['unreadCount']")
echo "  ✓ 未讀通知: $UNREAD"

# 標記已讀
curl -sf -X POST "$BASE/notifications/$NOTIF_ID/read" -H "$CT" -H "$AUTH" > /dev/null
echo "  ✓ 標記已讀"

# 批量發送
BULK=$(curl -sf -X POST "$BASE/notifications/send-bulk" -H "$CT" -H "$AUTH_ADMIN" \
  -d '{"userIds":["user-01","user-02","user-03"],"type":"BUDGET_WARNING","title":"預算警告","body":"材料預算已達 28%"}')
echo "  ✓ 批量通知: $(echo "$BULK" | json_field "['created']") 筆"

# ═══════════════════════════════════════
# 5. 稽核日誌 (Audit Logs)
# ═══════════════════════════════════════
echo ""
echo "━━━ 5. 稽核日誌 ━━━"

AUDIT=$(curl -sf "$BASE/audit-logs" -H "$AUTH")
AUDIT_TOTAL=$(echo "$AUDIT" | json_field "['total']")
echo "  ✓ 稽核記錄: $AUDIT_TOTAL 筆"

# 按資源查詢
AUDIT_SR=$(curl -sf "$BASE/audit-logs?resource=SR" -H "$AUTH")
AUDIT_SR_CNT=$(echo "$AUDIT_SR" | json_field "['total']")
echo "  ✓ SR 稽核記錄: $AUDIT_SR_CNT 筆"

# ═══════════════════════════════════════
# 6. 單價資料庫 (Unit Prices)
# ═══════════════════════════════════════
echo ""
echo "━━━ 6. 單價資料庫 ━━━"

UP_LIST=$(curl -sf "$BASE/unit-prices" -H "$AUTH")
UP_TOTAL=$(echo "$UP_LIST" | json_field "['total']")
echo "  ✓ 單價記錄: $UP_TOTAL 筆"

# 新增
UP_NEW=$(curl -sf -X POST "$BASE/unit-prices" -H "$CT" -H "$AUTH" \
  -d '{"category":"MATERIAL","itemName":"H型鋼 H300","unit":"噸","unitPrice":32000,"vendorName":"中鋼","region":"北部"}')
echo "  ✓ 新增: $(echo "$UP_NEW" | json_field "['itemName']") @ $(echo "$UP_NEW" | json_field "['unitPrice']")"

# 價格分析
ANALYSIS=$(curl -sf "$BASE/unit-prices/analysis?itemName=SD420%20%238%20%E9%8B%BC%E7%AD%8B&category=MATERIAL" -H "$AUTH")
AVG=$(echo "$ANALYSIS" | json_field "['avgPrice']")
echo "  ✓ 鋼筋均價: $AVG"

# 報價比較
COMPARE=$(curl -sf -X POST "$BASE/unit-prices/compare" -H "$CT" -H "$AUTH" \
  -d '{"itemName":"SD420 #8 鋼筋","category":"MATERIAL","quotedPrice":35000}')
ASSESS=$(echo "$COMPARE" | json_field "['assessment']")
DIFF=$(echo "$COMPARE" | json_field "['priceDiffPercent']")
echo "  ✓ 報價比較: 35000 vs 均價 → $ASSESS ($DIFF%)"

# ═══════════════════════════════════════
# 7. OCR (Mock)
# ═══════════════════════════════════════
echo ""
echo "━━━ 7. OCR 掃描 (Mock) ━━━"

OCR_Q=$(curl -sf -X POST "$BASE/ocr/scan" -H "$CT" -H "$AUTH" \
  -d '{"fileType":"quotation","fileName":"vendor-quote.pdf"}')
OCR_VENDOR=$(echo "$OCR_Q" | json_field "['vendorName']")
OCR_CONF=$(echo "$OCR_Q" | json_field "['confidence']")
echo "  ✓ 報價單掃描: 廠商=$OCR_VENDOR 信心=$OCR_CONF"

OCR_I=$(curl -sf -X POST "$BASE/ocr/scan" -H "$CT" -H "$AUTH" \
  -d '{"fileType":"invoice","fileName":"invoice-001.pdf"}')
OCR_INV_NUM=$(echo "$OCR_I" | json_field "['invoiceNumber']")
echo "  ✓ 發票掃描: 發票號=$OCR_INV_NUM"

# ═══════════════════════════════════════
# 8. 報表 (Reports)
# ═══════════════════════════════════════
echo ""
echo "━━━ 8. 報表 / 儀表板 ━━━"

DASH=$(curl -sf "$BASE/reports/dashboard" -H "$AUTH")
SR_CNT=$(echo "$DASH" | json_field "['srCount']['total']")
PO_AMT=$(echo "$DASH" | json_field "['totalPOAmount']")
echo "  ✓ 儀表板: SR=$SR_CNT, PO金額=$PO_AMT"

PROJ_SUM=$(curl -sf "$BASE/reports/project/$PROJECT_ID/summary" -H "$AUTH")
BUDGETS=$(echo "$PROJ_SUM" | json_field "['budgets'].__len__()")
echo "  ✓ 專案摘要: $BUDGETS 項預算"

PROGRESS=$(curl -sf "$BASE/reports/procurement-progress?projectId=$PROJECT_ID" -H "$AUTH")
MONTHS=$(echo "$PROGRESS" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))")
echo "  ✓ 採購進度: $MONTHS 個月數據"

VENDOR=$(curl -sf "$BASE/reports/vendor-analysis?projectId=$PROJECT_ID" -H "$AUTH")
VENDOR_CNT=$(echo "$VENDOR" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))")
echo "  ✓ 廠商分析: $VENDOR_CNT 家"

TIMELINE=$(curl -sf "$BASE/reports/approval-timeline" -H "$AUTH")
TIMELINE_CNT=$(echo "$TIMELINE" | json_field "['count']")
echo "  ✓ 簽核時程: $TIMELINE_CNT 筆"

EXPORT=$(curl -sf "$BASE/reports/export/budget-status?projectId=$PROJECT_ID" -H "$AUTH")
EXPORT_CNT=$(echo "$EXPORT" | json_field "['count']")
echo "  ✓ 匯出預算: $EXPORT_CNT 筆"

# ═══════════════════════════════════════
# Summary
# ═══════════════════════════════════════
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   ✓ 周邊功能全部測試通過!               ║"
echo "╠══════════════════════════════════════════╣"
echo "║  1. 預算管理      ✓ 查詢/檢查/消耗       ║"
echo "║  2. 變更單        ✓ 建立→送審→核准        ║"
echo "║  3. 自動傳票      ✓ 請款核准→傳票→確認    ║"
echo "║  4. 通知          ✓ 發送/查詢/已讀/批量    ║"
echo "║  5. 稽核日誌      ✓ 自動記錄/查詢         ║"
echo "║  6. 單價資料庫    ✓ 新增/分析/比較         ║"
echo "║  7. OCR掃描       ✓ 報價單/發票 (Mock)    ║"
echo "║  8. 報表/儀表板   ✓ 6種報表端點           ║"
echo "╚══════════════════════════════════════════╝"
