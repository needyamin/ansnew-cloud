#!/usr/bin/env bash
# Regression check for the FileService::transfer() dir-handling bug:
# copying a directory that CONTAINS a subdirectory used to throw
#   relInside(): Argument #2 ($child) must be of type string, array given
# because the $dirs entries are arrays ({path,name}) and were passed raw.
#
# Requires the stack up at http://127.0.0.1:8080 with admin/admin.
set -uo pipefail

BASE="http://127.0.0.1:8080"
PY="/c/Users/needyamin/.workbuddy-ai/binaries/python/versions/3.13.12/python.exe"
CJ="/tmp/ansnew_xfer.txt"; : > "$CJ"

TOK=$(curl -s -c "$CJ" "$BASE/api/bootstrap" | "$PY" -c "import sys,json;print(json.load(sys.stdin)['data']['csrf'])")
CSRF=$(curl -s -b "$CJ" -c "$CJ" -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" -H "X-CSRF-Token: $TOK" \
  -d '{"username":"admin","password":"admin"}' | "$PY" -c "import sys,json;print(json.load(sys.stdin)['data']['csrf'])")
echo "logged in (csrf ${#CSRF})"

post() { curl -s -b "$CJ" -X POST -H "Content-Type: application/json" -H "X-CSRF-Token: $CSRF" "$BASE$1" -d "$2"; }

echo "1) mkdir /verify-src          -> $(post /api/fs/local/mkdir '{"path":"/","name":"verify-src"}' | head -c 90)"
echo "2) mkdir /verify-src/sub      -> $(post /api/fs/local/mkdir '{"path":"/verify-src","name":"sub"}' | head -c 90)"
echo "3) create /verify-src/sub/file.txt -> $(post /api/fs/local/file '{"path":"/verify-src/sub","name":"file.txt"}' | head -c 90)"

COPY=$(post /api/fs/local/copy '{"path":"/verify-src","destDir":"/","destMount":"local","conflict":"rename"}')
echo "4) copy (dir -> async job)    -> $COPY"
JOB=$(printf '%s' "$COPY" | "$PY" -c "import sys,json;print(json.load(sys.stdin)['data'].get('job',''))")
echo "   job id: $JOB"

STATUS=""
for i in $(seq 1 40); do
  LINE=$(curl -s -b "$CJ" "$BASE/api/jobs?limit=30" | "$PY" -c "
import sys,json
jid='$JOB'
for j in json.load(sys.stdin)['data']['jobs']:
    if str(j.get('id'))==jid:
        print(j.get('status'),'|',(j.get('message') or ''),'|',(j.get('result') or ''))
        break
else:
    print('notfound')
")
  echo "   poll $i: $LINE"
  STATUS=$(printf '%s' "$LINE" | cut -d'|' -f1 | tr -d ' ')
  case "$STATUS" in done|error|canceled) break;; esac
  sleep 1
done

echo "5) root listing:"
curl -s -b "$CJ" "$BASE/api/fs/local/list?path=/" | "$PY" -c "import sys,json;print('   ',sorted(e['name'] for e in json.load(sys.stdin)['data']['entries']))"
echo "6) '/verify-src (2)' listing:"
curl -s -b "$CJ" --get "$BASE/api/fs/local/list" --data-urlencode "path=/verify-src (2)" | "$PY" -c "import sys,json;print('   ',sorted(e['name'] for e in json.load(sys.stdin)['data']['entries']))" 2>/dev/null || echo "   (missing)"
echo "7) '/verify-src (2)/sub' listing:"
curl -s -b "$CJ" --get "$BASE/api/fs/local/list" --data-urlencode "path=/verify-src (2)/sub" | "$PY" -c "import sys,json;print('   ',sorted(e['name'] for e in json.load(sys.stdin)['data']['entries']))" 2>/dev/null || echo "   (missing)"

echo
if [ "$STATUS" = "done" ]; then echo "RESULT: PASS (copy job completed, no TypeError)"; else echo "RESULT: CHECK (job status=$STATUS)"; fi

# cleanup (dir deletes are async jobs)
post /api/fs/local/delete '{"path":"/verify-src","permanent":true}' >/dev/null
post /api/fs/local/delete '{"path":"/verify-src (2)","permanent":true}' >/dev/null
echo "cleanup jobs enqueued"
