#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Digimart smoke tests
#
# 1. Proves this machine's SHA-512 matches Digimart's worked example.
# 2. Calls the REST APIs you have configured, with your credentials.
# 3. Optionally prints a freshly signed authorize URL to open in a browser.
#
# Only services with a URL set in the environment are tested. Configure them in
# .env; see templates/.env.example.
#
# Usage:
#   cp templates/.env.example .env && $EDITOR .env
#   ./scripts/smoke-test.sh                     # hashing + read-only REST calls
#   ./scripts/smoke-test.sh --print-url         # also print signed URLs to open by hand
#   TEST_SUBSCRIBER_ID=<masked id> ./scripts/smoke-test.sh --with-unsubscribe
#                                               # also UNSUBSCRIBES that subscriber — real effect
#
# The charging flows cannot be smoke-tested from a shell: they are pages the
# customer completes with an OTP. --print-url gives you a URL to open; the flow
# itself is yours to walk through with an allowed test number.
#
# RUN THIS FROM THE SERVER THAT WILL CALL DIGIMART. Credentials come from the
# environment. Never paste them into this file.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

[ -f .env ] && set -a && . ./.env && set +a

PRINT_URL=false; WITH_UNSUB=false
for arg in "$@"; do
  case "$arg" in
    --print-url) PRINT_URL=true ;;
    --with-unsubscribe) WITH_UNSUB=true ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done

GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; YELLOW=$'\033[0;33m'; DIM=$'\033[2m'; NC=$'\033[0m'
PASS=0; FAIL=0; SKIP=0
skip() { printf '%-34s%s\n' "$1" "${DIM}$2${NC}"; SKIP=$((SKIP+1)); }

sha512hex() { printf '%s' "$1" | openssl dgst -sha512 | awk '{print $NF}'; }

echo
echo "── Hashing ─────────────────────────────────────────────"
printf '%-34s' "SHA-512 of the worked example"
EXPECTED=3badf638ceca499000fd07b899e5fc0cec348d9762886b8430104291126683892845a208caef8e99b53432571e46c5f04162a1a25646443f7935239ea0901b38
if ! command -v openssl >/dev/null; then
  echo "${YELLOW}openssl not found — skipped${NC}"; SKIP=$((SKIP+1))
elif [ "$(sha512hex 'myApiKey123|2024-08-08T12:00:00Z|mySecretKey456|50')" = "$EXPECTED" ]; then
  echo "${GREEN}matches${NC}"; PASS=$((PASS+1))
else
  echo "${RED}MISMATCH — this machine's hashing is not what Digimart expects${NC}"; FAIL=$((FAIL+1))
fi

# rest <name> <url> <json-body> <success-codes-regex>
rest() {
  local name="$1" url="$2" body="$3" ok="$4"
  printf '%-34s' "$name"
  local response code
  response=$(curl -sS --max-time 20 -X POST "$url" \
    -H 'Content-Type: application/json;charset=utf-8' --data "$body" 2>&1)
  if [ -z "$response" ]; then
    echo "${RED}NO RESPONSE${NC}  (network, firewall, or TLS chain problem)"; FAIL=$((FAIL+1)); return
  fi
  code=$(printf '%s' "$response" | grep -o '"statusCode"[[:space:]]*:[[:space:]]*"[A-Z0-9]*"' | head -1 | grep -o '[SE][0-9]\{4\}')
  if printf '%s' "$code" | grep -Eq "^($ok)$"; then
    echo "${GREEN}$code${NC}"; PASS=$((PASS+1))
  else
    echo "${RED}${code:-no statusCode}${NC}"
    echo "${DIM}  $(printf '%s' "$response" | head -c 300)${NC}"
    echo "${DIM}  REST codes other than S1000 have no published meaning — statusDetail is the explanation.${NC}"
    FAIL=$((FAIL+1))
  fi
}

echo
echo "── REST (api.digimart.store) ───────────────────────────"
if [ -z "${DIGIMART_APP_ID:-}" ] || [ -z "${DIGIMART_PASSWORD:-}" ]; then
  skip "REST calls" "DIGIMART_APP_ID / DIGIMART_PASSWORD not set"
else
  CRED="\"applicationId\":\"$DIGIMART_APP_ID\",\"password\":\"$DIGIMART_PASSWORD\""

  if [ -n "${DIGIMART_GET_SUBSCRIBERS_URL:-}" ]; then
    rest "Subscriber List (page 1)" "$DIGIMART_GET_SUBSCRIBERS_URL" \
      "{$CRED,\"version\":\"2.0\",\"requestPage\":1}" "S1000|S1001"
  else skip "Subscriber List" "DIGIMART_GET_SUBSCRIBERS_URL not set"; fi

  if [ -n "${DIGIMART_CHARGING_INFO_URL:-}" ] && [ -n "${TEST_SUBSCRIBER_ID:-}" ]; then
    rest "Subscriber Charging Info" "$DIGIMART_CHARGING_INFO_URL" \
      "{$CRED,\"subscriberId\":[\"tel:${TEST_SUBSCRIBER_ID#tel:}\"]}" "S1000"
  else skip "Subscriber Charging Info" "needs DIGIMART_CHARGING_INFO_URL and TEST_SUBSCRIBER_ID"; fi

  if $WITH_UNSUB; then
    if [ -n "${DIGIMART_UNREGISTRATION_URL:-}" ] && [ -n "${TEST_SUBSCRIBER_ID:-}" ]; then
      echo "${YELLOW}  Unsubscribing ${TEST_SUBSCRIBER_ID:0:6}… — this is real.${NC}"
      rest "User Unsubscription" "$DIGIMART_UNREGISTRATION_URL" \
        "{$CRED,\"subscriberId\":\"tel:${TEST_SUBSCRIBER_ID#tel:}\",\"action\":\"0\"}" "S1000"
    else skip "User Unsubscription" "needs DIGIMART_UNREGISTRATION_URL and TEST_SUBSCRIBER_ID"; fi
  else skip "User Unsubscription" "pass --with-unsubscribe to run it"; fi
fi

if $PRINT_URL; then
  echo
  echo "── Signed URLs to open in a browser ────────────────────"
  if [ -z "${DIGIMART_API_KEY:-}" ] || [ -z "${DIGIMART_API_SECRET:-}" ] || [ -z "${DIGIMART_REDIRECT_URL:-}" ]; then
    skip "Authorize URLs" "DIGIMART_API_KEY / DIGIMART_API_SECRET / DIGIMART_REDIRECT_URL not set"
  else
    RT="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
    if [ -n "${DIGIMART_SUBSCRIPTION_AUTHORIZE_URL:-}" ]; then
      RID="$(date +%s)$(printf '%05d' $((RANDOM % 100000)))"
      SIG="$(sha512hex "$DIGIMART_API_KEY|$RT|$DIGIMART_API_SECRET")"
      echo "Subscription:"
      echo "  $DIGIMART_SUBSCRIPTION_AUTHORIZE_URL?apiKey=$DIGIMART_API_KEY&requestId=$RID&requestTime=$RT&signature=$SIG&redirectUrl=$DIGIMART_REDIRECT_URL"
    fi
    if [ -n "${DIGIMART_CAAS_AUTHORIZE_URL:-}" ]; then
      RID="$(date +%s)$(printf '%05d' $((RANDOM % 100000)))"
      AMOUNT="${TEST_AMOUNT:-1}"
      SIG="$(sha512hex "$DIGIMART_API_KEY|$RT|$DIGIMART_API_SECRET|$AMOUNT")"
      echo "One-time charge of $AMOUNT BDT (REAL money if completed):"
      echo "  $DIGIMART_CAAS_AUTHORIZE_URL?apiKey=$DIGIMART_API_KEY&requestId=$RID&requestTime=$RT&signature=$SIG&redirectUrl=$DIGIMART_REDIRECT_URL&amount=$AMOUNT"
    fi
    echo "${DIM}  Open within a minute or two — a stale requestTime is rejected (E1004).${NC}"
  fi
fi

echo
echo "────────────────────────────────────────────────────────"
echo "  ${GREEN}passed ${PASS}${NC}   ${RED}failed ${FAIL}${NC}   ${DIM}skipped ${SKIP}${NC}"
echo
[ "$FAIL" -eq 0 ] || exit 1
