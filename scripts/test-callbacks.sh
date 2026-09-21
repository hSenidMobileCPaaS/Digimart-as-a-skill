#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Digimart inbound handler tests
#
# Replays what Digimart sends — the charging notification, the subscription
# notification and the browser redirect — at your own handlers. No Digimart
# account or connectivity needed: the payloads are published.
#
# Usage:
#   ./scripts/test-callbacks.sh [base-url]
#   ./scripts/test-callbacks.sh http://localhost:3000
#
# Routes default to the ones the templates use; override if yours differ:
#   CHARGING_PATH=/api/digimart/charging/notify
#   SUBSCRIPTION_PATH=/api/digimart/subscription/notify
#   RETURN_PATH=/digimart/return
#
# Every notification must get HTTP 200 — including malformed, wrong-application
# and duplicate ones. Digimart publishes no response body and no redelivery
# policy, so a 4xx/5xx only loses you the event. Whether your handler PROCESSED
# each one correctly (once, and only the valid ones) is for you to check in your
# logs or database — the script prints what to look for.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

BASE="${1:-http://localhost:3000}"
APP_ID="${DIGIMART_APP_ID:-APP_000040}"
CHARGING_PATH="${CHARGING_PATH:-/api/digimart/charging/notify}"
SUBSCRIPTION_PATH="${SUBSCRIPTION_PATH:-/api/digimart/subscription/notify}"
RETURN_PATH="${RETURN_PATH:-/digimart/return}"

GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; YELLOW=$'\033[0;33m'; DIM=$'\033[2m'; NC=$'\033[0m'
PASS=0; FAIL=0

# post <name> <path> <body> [expectation]
post() {
  local name="$1" path="$2" body="$3" expect="${4:-}"
  printf '%-46s' "$name"
  local status
  status=$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' -X POST "$BASE$path" \
    -H 'Content-Type: application/json' --data "$body" 2>/dev/null)
  if [ "$status" = "200" ]; then
    echo "${GREEN}200${NC}${expect:+  ${DIM}→ expect: $expect${NC}}"; PASS=$((PASS+1))
  else
    echo "${RED}HTTP ${status:-000}${NC}  (must always be 200)"; FAIL=$((FAIL+1))
  fi
}

# get <name> <query> <must-not-contain-regex>
get() {
  local name="$1" query="$2" forbid="${3:-}"
  printf '%-46s' "$name"
  local out status body
  out=$(curl -sS --max-time 10 -w '\n%{http_code}' "$BASE$RETURN_PATH?$query" 2>/dev/null)
  status=$(printf '%s' "$out" | tail -1)
  body=$(printf '%s' "$out" | sed '$d')
  if [ "$status" != "200" ]; then
    echo "${RED}HTTP ${status:-000}${NC}  (the redirect page should always render)"; FAIL=$((FAIL+1)); return
  fi
  if [ -n "$forbid" ] && printf '%s' "$body" | grep -Eq "$forbid"; then
    echo "${RED}shows a raw status code to the customer${NC}"; FAIL=$((FAIL+1)); return
  fi
  echo "${GREEN}200${NC}"; PASS=$((PASS+1))
}

TS=$(date -u +%Y%m%d%H%M%S)

echo
echo "Inbound tests against $BASE"
echo "${DIM}Create orders for requestIds 123456789012346 (amount 50.95) and 123456789012100 (subscription)${NC}"
echo "${DIM}in your store first if you want to see them settle; unknown ones must still get 200.${NC}"
echo

echo "── Charging notification (Async charging resp URL) ─────"

post "Paid in full" "$CHARGING_PATH" \
  "{\"balanceDue\":0,\"subscriberId\":\"ZjUyMTM1MjlhYmU0ZmJmY2FkYjRkYWI3NzE2ZDg0MjE0NjNjYTM5MGFhZTczOWZlZDUxMTcxN2U3YTVlZTRiNmU=\",\"statusDetail\":\"Request was Successfully processed, Due amount fully paid.\",\"version\":\"2.0\",\"timeStamp\":\"$TS\",\"totalAmount\":\"50.95\",\"requestId\":\"123456789012346\",\"currency\":\"BDT\",\"applicationId\":\"$APP_ID\",\"internalTrxId\":\"924070309080000043\",\"paidAmount\":\"50.95\",\"statusCode\":\"S1000\"}" \
  "order settled once"

post "Failed — insufficient balance" "$CHARGING_PATH" \
  "{\"balanceDue\":10,\"subscriberId\":\"ZjUy\",\"statusDetail\":\"Your account balance is too low\",\"version\":\"2.0\",\"timeStamp\":\"$TS\",\"totalAmount\":\"10\",\"requestId\":\"123456789012399\",\"currency\":\"BDT\",\"applicationId\":\"$APP_ID\",\"internalTrxId\":\"924070309080000099\",\"paidAmount\":\"0\",\"statusCode\":\"E3009\"}" \
  "order FAILED, nothing delivered"

post "Paid less than asked" "$CHARGING_PATH" \
  "{\"balanceDue\":40.95,\"subscriberId\":\"ZjUy\",\"statusDetail\":\"Partially paid\",\"version\":\"2.0\",\"timeStamp\":\"$TS\",\"totalAmount\":\"50.95\",\"requestId\":\"123456789012346\",\"currency\":\"BDT\",\"applicationId\":\"$APP_ID\",\"internalTrxId\":\"924070309080000044\",\"paidAmount\":\"10.00\",\"statusCode\":\"S1000\"}" \
  "held for review, NOT delivered"

echo
echo "── Subscription notification (Subscription Notification URL) ─"

post "REGISTERED" "$SUBSCRIPTION_PATH" \
  "{\"timeStamp\":\"$TS\",\"subscriberId\":\"ZmQ5YmRmMDA5NzdlZTzM5NjJjNjRkNWNiMjkzOWYxMzk4MzI3ZjYyM2UwMmJmYzY3YzpncmFtZWVucGhvbmU=\",\"applicationId\":\"$APP_ID\",\"subscriberRequestId\":\"123456789012100\",\"version\":\"2.0\",\"frequency\":\"daily\",\"status\":\"REGISTERED\"}" \
  "subscriberId stored, access granted"

post "TEMPORARY_BLOCKED" "$SUBSCRIPTION_PATH" \
  "{\"timeStamp\":\"${TS}1\",\"subscriberId\":\"ZmQ5YmRmMDA5NzdlZTzM5NjJjNjRkNWNiMjkzOWYxMzk4MzI3ZjYyM2UwMmJmYzY3YzpncmFtZWVucGhvbmU=\",\"applicationId\":\"$APP_ID\",\"subscriberRequestId\":\"123456789012100\",\"version\":\"2.0\",\"frequency\":\"daily\",\"status\":\"TEMPORARY_BLOCKED\"}" \
  "access suspended, record kept"

post "Old tutorial shape (app id under the requestId key)" "$SUBSCRIPTION_PATH" \
  "{\"timeStamp\":\"${TS}2\",\"subscriberId\":\"ZmQ5\",\"subscriberRequestId\":\"123456789012100\",\"123456789012100\":\"$APP_ID\",\"version\":\"2.0\",\"frequency\":\"daily\",\"status\":\"REGISTERED\"}" \
  "tolerated and logged, not crashed"

echo
echo "── Hostile payloads (must still return 200) ────────────"

post "Malformed JSON" "$CHARGING_PATH" '{not valid json' "ignored"
post "Empty body" "$SUBSCRIPTION_PATH" '' "ignored"
post "Wrong applicationId" "$CHARGING_PATH" \
  "{\"requestId\":\"123456789012346\",\"applicationId\":\"APP_999999\",\"internalTrxId\":\"1\",\"paidAmount\":\"50.95\",\"balanceDue\":0,\"statusCode\":\"S1000\"}" \
  "ignored — NOT settled"
post "Unknown requestId" "$CHARGING_PATH" \
  "{\"requestId\":\"999999999999999\",\"applicationId\":\"$APP_ID\",\"internalTrxId\":\"2\",\"paidAmount\":\"5\",\"balanceDue\":0,\"statusCode\":\"S1000\"}" \
  "ignored — no order"
post "Oversized" "$SUBSCRIPTION_PATH" \
  "{\"subscriberId\":\"$(printf 'A%.0s' {1..5000})\",\"status\":\"REGISTERED\"}" "rejected or truncated safely"

echo
echo "── Idempotency (the test people skip) ──────────────────"
echo "${DIM}  Same payload twice. Both must return 200, and your handler must act ONCE.${NC}"
DUP="{\"balanceDue\":0,\"subscriberId\":\"ZjUy\",\"statusDetail\":\"ok\",\"version\":\"2.0\",\"timeStamp\":\"$TS\",\"totalAmount\":\"50\",\"requestId\":\"123456789012555\",\"currency\":\"BDT\",\"applicationId\":\"$APP_ID\",\"internalTrxId\":\"dup-test-001\",\"paidAmount\":\"50\",\"statusCode\":\"S1000\"}"
post "Charging notification (1st)" "$CHARGING_PATH" "$DUP" "processed"
post "Charging notification (2nd)" "$CHARGING_PATH" "$DUP" "deduplicated — NOT processed again"
SUB_DUP="{\"timeStamp\":\"20260908093000\",\"subscriberId\":\"ZmQ5dup\",\"applicationId\":\"$APP_ID\",\"subscriberRequestId\":\"123456789012100\",\"version\":\"2.0\",\"frequency\":\"monthly\",\"status\":\"REGISTERED\"}"
post "Subscription notification (1st)" "$SUBSCRIPTION_PATH" "$SUB_DUP" "processed"
post "Subscription notification (2nd)" "$SUBSCRIPTION_PATH" "$SUB_DUP" "deduplicated"

echo
echo "── Redirect return (untrusted) ─────────────────────────"
echo "${DIM}  A forged ?subscriptionStatus=S1000 must NOT settle anything — check your store.${NC}"
get "Forged success" "subscriptionStatus=S1000&subscriberId=forged&requestId=123456789012346"
get "Insufficient balance" "subscriptionStatus=E3009&subscriberId=abc&requestId=123456789012346" 'E3009'
get "Invalid signature (our bug)" "subscriptionStatus=E1002&subscriberId=abc&requestId=123456789012346" 'E1002'
get "Unknown requestId" "subscriptionStatus=S1000&subscriberId=abc&requestId=000000000000000"
get "No parameters" ""

echo
echo "────────────────────────────────────────────────────────"
echo "  ${GREEN}passed ${PASS}${NC}   ${RED}failed ${FAIL}${NC}"
echo "  ${YELLOW}Now check your logs/store: each 'expect' above is what should have happened.${NC}"
echo
[ "$FAIL" -eq 0 ] || exit 1
