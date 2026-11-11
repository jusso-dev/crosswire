#!/usr/bin/env bash
# Post-deploy smoke test (#75). Usage: scripts/smoke.sh https://crosswire.example.com [expected-migration-tag]
# Checks: /healthz 200, /readyz 200 with migrations ok (and matching tag if given), /sign-in 200,
# unauthenticated /api/me 401, unauthenticated POST /api/chat 401, security headers present.
# Each check retries with a short backoff (#143), so a cold start does not fail the deploy.
# SMOKE_ATTEMPTS (default 6) and SMOKE_DELAY (seconds, default 5) tune the retries.
set -euo pipefail
BASE="${1:?usage: smoke.sh <base-url> [expected-migration-tag]}"
BASE="${BASE%/}"
EXPECTED="${2:-}"
ATTEMPTS="${SMOKE_ATTEMPTS:-6}"
DELAY="${SMOKE_DELAY:-5}"
BODY="$(mktemp)"
trap 'rm -f "$BODY"' EXIT
fail=0

status() { # curl args... -> prints the HTTP status, or 000 when the request did not complete
  local got
  got=$(curl -sS -o "$BODY" -w '%{http_code}' --max-time 20 "$@" 2>/dev/null || true)
  echo "${got:-000}"
}

check() { # name, expected status, curl args...
  local name="$1" want="$2"; shift 2
  local got="000" i
  for i in $(seq 1 "$ATTEMPTS"); do
    got=$(status "$@")
    [ "$got" = "$want" ] && break
    [ "$i" -lt "$ATTEMPTS" ] && { echo "WAIT $name: got $got, attempt $i of $ATTEMPTS"; sleep $((DELAY * i)); }
  done
  if [ "$got" = "$want" ]; then echo "PASS $name ($got)"; else echo "FAIL $name: expected $want, got $got"; head -c 300 "$BODY"; echo; fail=1; fi
}

check "healthz" 200 "$BASE/healthz"
check "readyz" 200 "$BASE/readyz"
mig=$(sed -n 's/.*"migration":"\([^"]*\)".*/\1/p' "$BODY")
echo "INFO migration=${mig:-unknown}"
if [ -n "$EXPECTED" ] && [ "$mig" != "$EXPECTED" ]; then echo "FAIL migration: expected $EXPECTED, got ${mig:-none}"; fail=1; fi
check "sign-in page" 200 "$BASE/sign-in"
check "unauth /api/me" 401 "$BASE/api/me"
check "unauth POST /api/chat" 401 -X POST -H 'content-type: application/json' -d '{}' "$BASE/api/chat"
hdrs=$(curl -sS -D - -o /dev/null --max-time 20 --retry 3 --retry-delay 3 --retry-connrefused "$BASE/sign-in" | tr -d '\r' || true)
for h in content-security-policy x-content-type-options x-request-id; do
  if echo "$hdrs" | grep -qi "^$h:"; then echo "PASS header $h"; else echo "FAIL header $h missing"; fail=1; fi
done
if [[ "$BASE" == https://* ]]; then
  if echo "$hdrs" | grep -qi '^strict-transport-security:'; then echo "PASS header strict-transport-security"; else echo "FAIL HSTS missing on https"; fail=1; fi
fi
exit $fail
