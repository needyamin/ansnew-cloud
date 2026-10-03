#!/usr/bin/env bash
# ANSNEW CLOUD functional smoke test: exercises every background job type, which is
# where the namespace / callback-arity bugs lived.
set -uo pipefail

BASE=http://127.0.0.1:8081
J=/tmp/nf-jobs.jar
rm -f "$J"
PW="${ANSNEW_PW:?set ANSNEW_PW}"
PASS=0; FAIL=0

csrf() { grep -oE '"csrf":"[^"]+"' | head -1 | sed 's/.*:"//;s/"//'; }

req() { # method path [json]
  local m=$1 p=$2 d=${3:-}
  if [ -n "$d" ]; then
    curl -s -b "$J" -c "$J" -X "$m" "$BASE$p" \
      -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d "$d"
  else
    curl -s -b "$J" -c "$J" -X "$m" "$BASE$p"
  fi
}

# Poll /api/jobs until the given job id leaves the queued/running state.
await_job() {
  local id=$1 i=0 out status
  while [ $i -lt 40 ]; do
    out=$(curl -s -b "$J" "$BASE/api/jobs")
    status=$(echo "$out" | tr ',' '\n' | grep -A2 "\"$id\"" | grep -oE '"status":"[a-z]+"' | head -1 | sed 's/.*:"//;s/"//')
    case "$status" in
      done|error) echo "$status|$(echo "$out" | grep -oE '"message":"[^"]*"' | head -1 | sed 's/.*:"//;s/"//')"; return ;;
    esac
    sleep 0.5; i=$((i+1))
  done
  echo "timeout|still running"
}

check() { # label expected actual
  if [ "$2" = "$3" ]; then echo "  PASS  $1"; PASS=$((PASS+1));
  else echo "  FAIL  $1  (expected=$2 got=$3)"; FAIL=$((FAIL+1)); fi
}

check_contains() { # label needle haystack
  case "$3" in
    *"$2"*) echo "  PASS  $1"; PASS=$((PASS+1)) ;;
    *)      echo "  FAIL  $1  ('$2' not in '$3')"; FAIL=$((FAIL+1)) ;;
  esac
}

# Archives are encrypted at rest, so listing entries has to go through the API
# (reading the raw bytes off disk would only ever show ciphertext).
zlist() { # archive filename relative to the mount root
  local tmp; tmp=$(mktemp)
  curl -s -b "$J" "$BASE/api/fs/local/download?path=/$1" -o "$tmp"
  docker exec -i ansnew-cloud-php-1 sh -c 'cat > /tmp/ansnew-z.zip' < "$tmp"
  docker exec ansnew-cloud-php-1 sh -c 'unzip -Z1 /tmp/ansnew-z.zip 2>/dev/null' | tr '\n' ' '
  docker exec ansnew-cloud-php-1 rm -f /tmp/ansnew-z.zip
  rm -f "$tmp"
}

run_job() { # label route json
  local label=$1 route=$2 data=$3 resp job res st msg
  resp=$(req POST "$route" "$data")
  job=$(echo "$resp" | grep -oE '"job":"[^"]+"' | sed 's/.*:"//;s/"//')
  if [ -z "$job" ]; then echo "  FAIL  $label  (enqueue failed: $resp)"; FAIL=$((FAIL+1)); return; fi
  res=$(await_job "$job"); st=${res%%|*}; msg=${res#*|}
  if [ "$st" = "done" ]; then echo "  PASS  $label"; PASS=$((PASS+1));
  else echo "  FAIL  $label  ($st: $msg)"; FAIL=$((FAIL+1)); fi
}

echo "== setup =="
CSRF=$(curl -s -c "$J" "$BASE/api/bootstrap" | csrf)
CSRF=$(curl -s -b "$J" -c "$J" -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
  -d "{\"username\":\"admin\",\"password\":\"$PW\"}" | csrf)
check "login" "true" "$([ -n "$CSRF" ] && echo true || echo false)"

req POST /api/fs/local/mkdir '{"path":"/","name":"demo"}' >/dev/null
req POST /api/fs/local/file  '{"path":"/demo","name":"hello.txt"}' >/dev/null
req POST /api/fs/local/file  '{"path":"/demo","name":"world.txt"}' >/dev/null
req POST /api/fs/local/mkdir '{"path":"/","name":"out"}' >/dev/null
req POST /api/fs/local/mkdir '{"path":"/","name":"moveme"}' >/dev/null
req POST /api/fs/local/file  '{"path":"/moveme","name":"m.txt"}' >/dev/null

echo "== background jobs =="
run_job "archive  (zip /demo)"            /api/fs/local/archive         '{"paths":["/demo"],"destDir":"/","format":"zip","name":"demo.zip"}'
run_job "extract  (demo.zip -> /out)"     /api/fs/local/extract         '{"path":"/demo.zip","destDir":"/out"}'
run_job "copy     (/demo -> /)"           /api/fs/local/copy            '{"path":"/demo","destDir":"/","destMount":"local","conflict":"rename"}'
run_job "move     (/moveme -> /out)"      /api/fs/local/move            '{"path":"/moveme","destDir":"/out","destMount":"local","conflict":"rename"}'
run_job "du       (usage scan)"           /api/usage/local/scan         '{}'
run_job "download-folder (/demo)"         /api/fs/local/download-folder '{"path":"/demo"}'
run_job "delete   (/demo permanent)"      /api/fs/local/delete          '{"path":"/demo","permanent":true}'

echo "== archive edge cases (regression) =="
req POST /api/fs/local/mkdir '{"path":"/","name":"emptydir"}'    >/dev/null
req POST /api/fs/local/file  '{"path":"/","name":"one.txt"}'     >/dev/null
req POST /api/fs/local/mkdir '{"path":"/","name":"tree"}'        >/dev/null
req POST /api/fs/local/mkdir '{"path":"/tree","name":"emptySub"}' >/dev/null
req POST /api/fs/local/file  '{"path":"/tree","name":"a.txt"}'   >/dev/null

run_job "archive empty folder"       /api/fs/local/archive '{"paths":["/emptydir"],"destDir":"/","format":"zip","name":"empty.zip"}'
run_job "archive single file"        /api/fs/local/archive '{"paths":["/one.txt"],"destDir":"/","format":"zip","name":"one.zip"}'
run_job "archive folder+empty sub"   /api/fs/local/archive '{"paths":["/tree"],"destDir":"/","format":"zip","name":"tree.zip"}'
run_job "archive tar.gz"             /api/fs/local/archive '{"paths":["/tree"],"destDir":"/","format":"tar.gz","name":"tree.tar.gz"}'

# Entry names must be mount-relative. A bare basename used to strip to '' and
# make ZipArchive fall back to the full container path.
check "single-file entry name" "one.txt " "$(zlist one.zip)"
check_contains "empty folder preserved" "emptydir/" "$(zlist empty.zip)"
check_contains "empty subdir preserved" "tree/emptySub/" "$(zlist tree.zip)"
check_contains "files present in tree.zip" "tree/a.txt" "$(zlist tree.zip)"

echo "== filesystem state =="
docker exec ansnew-cloud-php-1 sh -c 'find /srv/storage/local -maxdepth 3 | sort' 2>&1 | sed 's/^/  /'
echo "== zip integrity (via API; archives are encrypted at rest) =="
ZDEMO=$(mktemp)
curl -s -b "$J" "$BASE/api/fs/local/download?path=/demo.zip" -o "$ZDEMO"
docker exec -i ansnew-cloud-php-1 sh -c 'cat > /tmp/ansnew-demo.zip' < "$ZDEMO"
docker exec ansnew-cloud-php-1 sh -c 'unzip -l /tmp/ansnew-demo.zip 2>&1 | tail -6' | sed 's/^/  /'
docker exec ansnew-cloud-php-1 rm -f /tmp/ansnew-demo.zip
rm -f "$ZDEMO"

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
