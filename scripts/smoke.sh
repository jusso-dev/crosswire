#!/usr/bin/env bash
# Post-deploy smoke test (#75). Usage: scripts/smoke.sh https://crosswire.example.com [expected-migration-tag]
# Checks: /healthz 200, /readyz 200 with migrations ok (and matching tag if given), /sign-in 200,
# unauthenticated /api/me 401, unauthenticated POST /api/chat 401, security headers present.
set -euo pipefail
BASE="${1:?usage: smoke.sh <base-url> [expected-migration-tag]}"
BASE="${BASE%/}"
EXPECTED="${2:-}"
fail=0
check() { # name, expected status, curl args...
  local name="$1" want="$2"; shift 2
  local got
  got=$(curl -sS -o /tmp/smoke-body -w '%{http_code}' --max-time 20 "$@" || echo 000)
  if [ "$got" = "$want" ]; then echo "PASS $name ($got)"; else echo "FAIL $name: expected $want, got $got"; head -c 300 /tmp/smoke-body; echo; fail=1; fi
}
check "healthz" 200 "$BASE/healthz"
check "readyz" 200 "$BASE/readyz"
mig=$(curl -sS --max-time 20 "$BASE/readyz" | sed -n 's/.*"migration":"\([^"]*\)".*/\1/p')
echo "INFO migration=${mig:-unknown}"
if [ -n "$EXPECTED" ] && [ "$mig" != "$EXPECTED" ]; then echo "FAIL migration: expected $EXPECTED, got ${mig:-none}"; fail=1; fi
check "sign-in page" 200 "$BASE/sign-in"
check "unauth /api/me" 401 "$BASE/api/me"
check "unauth POST /api/chat" 401 -X POST -H 'content-type: application/json' -d '{}' "$BASE/api/chat"
hdrs=$(curl -sS -D - -o /dev/null --max-time 20 "$BASE/sign-in" | tr -d '\r')
for h in content-security-policy x-content-type-options x-request-id; do
  if echo "$hdrs" | grep -qi "^$h:"; then echo "PASS header $h"; else echo "FAIL header $h missing"; fail=1; fi
done
case "$BASE" in https://*) echo "$hdrs" | grep -qi '^strict-transport-security:' && echo "PASS header strict-transport-security" || { echo "FAIL HSTS missing on https"; fail=1; } ;; esac
exit $fail
