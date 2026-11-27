#!/bin/bash
# EPCOS V4 — 周邊功能端對端測試
set -e

BASE="http://localhost:3001/api/v1"
CT="Content-Type: application/json"

json_field() { python3 -c "import sys,json; print(json.load(sys.stdin)$1)"; }

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   EPCOS V4 周邊功能端對端測試            ║"
echo "╚══════════════════════════════════════════╝"

LOGIN_RESP=$(curl -sf -X POST "$BASE/auth/login" -H "$CT" -d '{"email":"huang@test.com"}')
TOKEN=$(echo "$LOGIN_RESP" | json_field "['token']")
AUTH="Authorization: Bearer $TOKEN"
ENTITY_ID=$(curl -sf "$BASE/auth/entities" | json_field "[0]['id']")
PROJECT_ID="proj-sy-001"

echo ""
echo "━━━ 1. 傳票 (Voucher) ━━━"
VOUCHERS=$(curl -sf "$BASE/vouchers" -H "$AUTH")
V_TOTAL=$(echo "$VOUCHERS" | json_field "['total']")
echo "  ✓ 傳票列表: 共 $V_TOTAL 筆"
if [ "$V_TOTAL" -gt 0 ]; then
  V_ID=$(echo "$VOUCHERS" | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; auto=[v for v in d if v['status']=='AUTO_CREATED']; print(auto[0]['id'] if auto else d[0]['id'])")
  V_CONFIRM=$(curl -sf -X POST "$BASE/vouchers/$V_ID/confirm" -H "$CT" -H "$AUTH" \
    -d '{"debitAccount":"6100","creditAccount":"2100"}')
  echo "  ✓ 傳票確認: $(echo "$V_CONFIRM" | json_field "['status']")"
fi

echo ""
echo "━━━ 2. 變更單 (Change Order) ━━━"
LOGIN_ENG=$(curl -sf -X POST "$BASE/auth/login" -H "$CT" -d '{"email":"chen@test.com"}')
TOKEN_ENG=$(echo "$LOGIN_ENG" | json_field "['token']")
AUTH_ENG="Authorization: Bearer $TOKEN_ENG"

CO_RESP=$(curl -sf -X POST "$BASE/change-orders" -H "$CT" -H "$AUTH_ENG" \
  -d "{\"legalEntityId\":\"$ENTITY_ID\",\"projectId\":\"$PROJECT_ID\",\"title\":\"追加鋼筋 10 噸\",\"reason\":\"設計變更\",\"originalAmount\":1400000,\"changeAmount\":280000,\"items\":[{\"name\":\"SD420 #8 鋼筋\",\"qty\":10,\"unit\":\"噸\",\"unitPrice\":28000}]}")
CO_ID=$(echo "$CO_RESP" | json_field "['id']")
CO_NUM=$(echo "$CO_RESP" | json_field "['docNumber']")
echo "  ✓ 建立: $CO_NUM (狀態: $(echo "$CO_RESP" | json_field "['status']"))"

CO_SUBMIT=$(curl -sf -X POST "$BASE/change-orders/$CO_ID/submit" -H "$CT" -H "$AUTH_ENG")
echo "  ✓ 送審: $(echo "$CO_SUBMIT" | json_field "['status']")"

LOGIN_PMGR=$(curl -sf -X POST "$BASE/auth/login" -H "$CT" -d '{"email":"zhang@test.com"}')
TOKEN_PMGR=$(echo "$LOGIN_PMGR" | json_field "['token']")
AUTH_PMGR="Authorization: Bearer $TOKEN_PMGR"

CO_APPROVE=$(curl -sf -X POST "$BASE/change-orders/$CO_ID/approve" -H "$CT" -H "$AUTH_PMGR" -d '{"comment":"核准"}')
echo "  ✓ 核准: $(echo "$CO_APPROVE" | json_field "['status']")"

echo ""
echo "━━━ 3. 預算控管 (Budget) ━━━"
BUDGETS=$(curl -sf "$BASE/budgets/project/$PROJECT_ID" -H "$AUTH")
B_COUNT=$(echo "$BUDGETS" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))")
echo "  ✓ 預算類別: $B_COUNT 筆"

B_CHECK=$(curl -sf -X POST "$BASE/budgets/check" -H "$CT" -H "$AUTH" \
  -d "{\"projectId\":\"$PROJECT_ID\",\"category\":\"MATERIAL\",\"amount\":1400000}")
echo "  ✓ 預算檢查: 可用=$(echo "$B_CHECK" | json_field "['available']"), 餘額=$(echo "$B_CHECK" | json_field "['remaining']")"

B_CONSUME=$(curl -sf -X POST "$BASE/budgets/consume" -H "$CT" -H "$AUTH" \
  -d "{\"projectId\":\"$PROJECT_ID\",\"category\":\"MATERIAL\",\"amount\":1400000}")
echo "  ✓ 預算消耗: 執行率=$(echo "$B_CONSUME" | json_field "['executionRate']")%, 警示=$(echo "$B_CONSUME" | json_field "['alertLevel']")"

echo ""
echo "━━━ 4. 通知 (Notification) ━━━"
N_SEND=$(curl -sf -X POST "$BASE/notifications/send" -H "$CT" -H "$AUTH" \
  -d '{"userId":"user-01","type":"APPROVAL_PENDING","title":"需求單待審核","body":"您有一份需求單需要審核"}')
N_ID=$(echo "$N_SEND" | json_field "['id']")
echo "  ✓ 發送通知: $N_ID"

LOGIN_WANG=$(curl -sf -X POST "$BASE/auth/login" -H "$CT" -d '{"email":"wang@test.com"}')
TOKEN_WANG=$(echo "$LOGIN_WANG" | json_field "['token']")
AUTH_WANG="Authorization: Bearer $TOKEN_WANG"

N_LIST=$(curl -sf "$BASE/notifications" -H "$AUTH_WANG")
echo "  ✓ 未讀: $(echo "$N_LIST" | json_field "['unreadCount']")"

N_READ=$(curl -sf -X POST "$BASE/notifications/$N_ID/read" -H "$CT" -H "$AUTH_WANG")
echo "  ✓ 標記已讀: $(echo "$N_READ" | json_field "['read']")"

echo ""
echo "━━━ 5. 稽核日誌 (Audit Log) ━━━"
AL_LIST=$(curl -sf "$BASE/audit-logs" -H "$AUTH")
echo "  ✓ 稽核日誌: 共 $(echo "$AL_LIST" | json_field "['total']") 筆"

echo ""
echo "━━━ 6. 單價資料庫 (Unit Price) ━━━"
UP_LIST=$(curl -sf "$BASE/unit-prices" -H "$AUTH")
echo "  ✓ 單價記錄: 共 $(echo "$UP_LIST" | json_field "['total']") 筆"

UP_ANALYSIS=$(curl -sf "$BASE/unit-prices/analysis?itemName=SD420%20%238%20%E9%8B%BC%E7%AD%8B" -H "$AUTH")
echo "  ✓ 鋼筋分析: 平均=$(echo "$UP_ANALYSIS" | json_field "['avgPrice']"), 筆數=$(echo "$UP_ANALYSIS" | json_field "['recordCount']")"

UP_COMPARE=$(curl -sf -X POST "$BASE/unit-prices/compare" -H "$CT" -H "$AUTH" \
  -d '{"itemName":"SD420 #8 鋼筋","category":"MATERIAL","quotedPrice":30000}')
echo "  ✓ 比價: $(echo "$UP_COMPARE" | json_field "['assessment']")"

echo ""
echo "━━━ 7. OCR 掃描 (Mock) ━━━"
OCR_RESP=$(curl -sf -X POST "$BASE/ocr/scan" -H "$CT" -H "$AUTH" \
  -d '{"fileType":"quotation","fileName":"quote-001.pdf"}')
echo "  ✓ 報價單: 廠商=$(echo "$OCR_RESP" | json_field "['vendorName']"), 金額=$(echo "$OCR_RESP" | json_field "['totalAmount']")"

OCR_INV=$(curl -sf -X POST "$BASE/ocr/scan" -H "$CT" -H "$AUTH" \
  -d '{"fileType":"invoice","fileName":"inv-001.pdf"}')
echo "  ✓ 發票: 號碼=$(echo "$OCR_INV" | json_field "['invoiceNumber']")"

echo ""
echo "━━━ 8. 報表 (Reports) ━━━"
DASH=$(curl -sf "$BASE/reports/dashboard?projectId=$PROJECT_ID" -H "$AUTH")
echo "  ✓ 儀表板: 待審核=$(echo "$DASH" | json_field "['pendingApprovals']")"

PROJ=$(curl -sf "$BASE/reports/project/$PROJECT_ID/summary" -H "$AUTH")
echo "  ✓ 專案摘要: $(echo "$PROJ" | json_field "['project']['name']")"

PROC=$(curl -sf "$BASE/reports/procurement-progress?projectId=$PROJECT_ID" -H "$AUTH")
echo "  ✓ 採購進度: $(echo "$PROC" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))") 月份"

VENDOR=$(curl -sf "$BASE/reports/vendor-analysis?projectId=$PROJECT_ID" -H "$AUTH")
echo "  ✓ 廠商分析: $(echo "$VENDOR" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))") 家"

EXPORT=$(curl -sf "$BASE/reports/export/budget-status?projectId=$PROJECT_ID" -H "$AUTH")
echo "  ✓ 匯出預算: $(echo "$EXPORT" | json_field "['count']") 筆"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   ✓ 周邊功能全部測試通過!               ║"
echo "╚══════════════════════════════════════════╝"
