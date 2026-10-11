#!/usr/bin/env bash
# Integration test for the editor's read path — the server half of the rule
# "an unrecognised file opens in the editor, unless it is really binary".
#
# It needs a running stack (the app on $BASE) and covers what the jsdom smoke
# test (tools/editor-smoke.mjs) cannot: the real HTTP status codes.
#
#   - a large BINARY file with an unknown extension -> 415, so preview.js shows
#     the hex view. It must NOT be 413: "too large to edit" would be useless.
#   - a large TEXT file                            -> 413 (too large to edit)
#   - a small TEXT file with an unknown extension  -> 200 with the contents
#   - a small BINARY file with an unknown extension-> 415
#
# Usage:  bash tools/editor-text-policy-test.sh [base-url]
# Note:   MSYS_NO_PATHCONV is required, and scratch files live under a Windows
#         path because curl is a Windows binary.

set -u
export MSYS_NO_PATHCONV=1

BASE="${1:-http://localhost:9090}"
MOUNT="${MOUNT:-local}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-admin}"

D="$(pwd -W 2>/dev/null || pwd)/.scratch-text-policy"
rm -rf "$D"; mkdir -p "$D"
trap 'rm -rf "$D"' EXIT

pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \033[32m\u2713\033[0m %s\n' "$1"; }
bad()  { fail=$((fail+1)); printf '  \033[31m\u2717\033[0m %s  %s\n' "$1" "${2:-}"; }
check(){ if [ "$2" = "$3" ]; then ok "$1 ($3)"; else bad "$1" "expected $3, got $2"; fi; }

# ---------------------------------------------------------------- auth
curl -sS -D "$D/h1" -o "$D/b1" "$BASE/api/bootstrap" || { echo "cannot reach $BASE"; exit 1; }
SID=$(sed -n 's/.*ANSNEW_SID=\([^;]*\).*/\1/ip' "$D/h1" | tail -1)
CSRF=$(sed -n 's/.*"csrf":"\([^"]*\)".*/\1/p' "$D/b1" | head -1)
curl -sS -D "$D/h2" -o "$D/b2" -H "Content-Type: application/json" -H "Cookie: ANSNEW_SID=$SID" \
  -H "X-CSRF-Token: $CSRF" -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}" "$BASE/api/auth/login"
SID=$(sed -n 's/.*ANSNEW_SID=\([^;]*\).*/\1/ip' "$D/h2" | tail -1)
CSRF=$(sed -n 's/.*"csrf":"\([^"]*\)".*/\1/p' "$D/b2" | head -1)
if [ -z "$SID" ]; then echo "login failed — check ADMIN_USER/ADMIN_PASS"; exit 1; fi
A=(-H "Cookie: ANSNEW_SID=$SID" -H "X-CSRF-Token: $CSRF")
# Deletes are gated behind a password confirmation.
curl -sS -o /dev/null "${A[@]}" -H "Content-Type: application/json" \
  -d "{\"password\":\"$ADMIN_PASS\",\"scope\":\"fs.delete\"}" "$BASE/api/auth/confirm"

# ---------------------------------------------------------------- fixtures
python - "$D" <<'PY'
import os, sys
d = sys.argv[1]
open(os.path.join(d, 'blob.xyz'), 'wb').write(os.urandom(6 * 1024 * 1024))  # binary, over the cap
open(os.path.join(d, 'big.log'),  'wb').write(b'a' * (6 * 1024 * 1024))     # text, over the cap
open(os.path.join(d, 'notes.xyz'),'wb').write(b'hello world\n')             # text, unknown ext
open(os.path.join(d, 'tiny.xyz'), 'wb').write(b'head\0tail')                # binary, tiny
PY

for f in blob.xyz big.log notes.xyz tiny.xyz; do
  curl -sS -o /dev/null "${A[@]}" -F "file=@$D/$f" "$BASE/api/upload/$MOUNT"
done

# ---------------------------------------------------------------- assert
status() {  # status <path> -> HTTP code
  curl -sS -o "$D/body" -w '%{http_code}' "${A[@]}" "$BASE/api/fs/$MOUNT/text?path=%2F$1"
}

echo "Editor read policy on mount '$MOUNT'"

code=$(status blob.xyz)
check "6 MiB binary, unknown ext -> hex view (415, not 413)" "$code" "415"

code=$(status tiny.xyz)
check "tiny binary, unknown ext -> hex view" "$code" "415"

code=$(status big.log)
check "6 MiB text -> too large to edit" "$code" "413"

code=$(status notes.xyz)
check "small text, unknown ext -> opens in the editor" "$code" "200"
content=$(python -c "
import json,sys
d=json.load(open(sys.argv[1]))
print(d['data']['content'] if d.get('ok') else '')
" "$D/body")
if [ "$content" = "hello world" ]; then ok "the editor receives the contents"; else bad "the editor receives the contents" "got '$content'"; fi

# ---------------------------------------------------------------- cleanup
for f in blob.xyz big.log notes.xyz tiny.xyz; do
  curl -sS -o /dev/null "${A[@]}" -H "Content-Type: application/json" \
    -d "{\"path\":\"/$f\",\"permanent\":true}" "$BASE/api/fs/$MOUNT/delete"
done
left=$(curl -sS "${A[@]}" "$BASE/api/fs/$MOUNT/list?path=%2F" | python -c "
import json,sys
names = [e['name'] for e in json.load(sys.stdin)['data']['entries']]
mine = [n for n in names if n in ('blob.xyz','big.log','notes.xyz','tiny.xyz')]
print(','.join(mine))
")
if [ -z "$left" ]; then ok "fixtures cleaned up"; else bad "fixtures cleaned up" "still present: $left"; fi

echo
if [ "$fail" -eq 0 ]; then echo "PASS — $pass passed, 0 failed"; else echo "FAIL — $pass passed, $fail failed"; fi
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
