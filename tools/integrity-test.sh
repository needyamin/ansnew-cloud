#!/usr/bin/env bash
# ANSNEW CLOUD integrity test: upload -> download byte-for-byte, archive -> unzip
# content check, and trash -> restore round-trip.
set -uo pipefail

# Git Bash on Windows rewrites `/box` into a Windows path (C:/...) before curl
# sees it, which the API correctly rejects as a drive-prefixed path. Exclude
# only the form-field argument from that conversion; `@file` still needs it.
export MSYS2_ARG_CONV_EXCL="path="

BASE=http://127.0.0.1:8081
J=/tmp/nf-int.jar
rm -f "$J"
PW="${ANSNEW_PW:?set ANSNEW_PW}"
PASS=0; FAIL=0

csrf() { grep -oE '"csrf":"[^"]+"' | head -1 | sed 's/.*:"//;s/"//'; }
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; PASS=$((PASS+1)); else echo "  FAIL  $1 (expected=$2 got=$3)"; FAIL=$((FAIL+1)); fi; }

CSRF=$(curl -s -c "$J" "$BASE/api/bootstrap" | csrf)
CSRF=$(curl -s -b "$J" -c "$J" -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
  -d "{\"username\":\"admin\",\"password\":\"$PW\"}" | csrf)
check "login" "true" "$([ -n "$CSRF" ] && echo true || echo false)"

# --- build a known payload -------------------------------------------------
WORK=/tmp/nf-payload
rm -rf "$WORK"; mkdir -p "$WORK"
head -c 300000 /dev/urandom > "$WORK/blob.bin"
SRC_MD5=$(md5sum "$WORK/blob.bin" | awk '{print $1}')

curl -s -b "$J" -X POST "$BASE/api/fs/local/mkdir" \
  -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
  -d '{"path":"/","name":"box"}' >/dev/null

echo "== upload (300 KB binary) =="
curl -s -b "$J" -X POST "$BASE/api/upload/local" \
  -H "X-CSRF-Token: $CSRF" -F "path=/box" -F "conflict=rename" \
  -F "file=@$WORK/blob.bin" >/dev/null

echo "== download back and compare =="
curl -s -b "$J" "$BASE/api/fs/local/download?path=/box/blob.bin" -o "$WORK/back.bin"
BACK_MD5=$(md5sum "$WORK/back.bin" | awk '{print $1}')
check "upload/download md5 matches" "$SRC_MD5" "$BACK_MD5"

echo "== archive /box then verify zip contents =="
JOB=$(curl -s -b "$J" -X POST "$BASE/api/fs/local/archive" \
  -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
  -d '{"paths":["/box"],"destDir":"/","format":"zip","name":"box.zip"}' \
  | grep -oE '"job":"[^"]+"' | sed 's/.*:"//;s/"//')
sleep 4
ST=$(curl -s -b "$J" "$BASE/api/jobs" | tr ',' '\n' | grep -A2 "\"$JOB\"" | grep -oE '"status":"[a-z]+"' | head -1 | sed 's/.*:"//;s/"//')
check "archive job status" "done" "$ST"

# The archive is encrypted at rest, so it must be fetched through the API
# (the raw bytes on disk are ciphertext). Verify by unzipping the downloaded copy.
ZIPTMP=$(mktemp)
curl -s -b "$J" "$BASE/api/fs/local/download?path=/box.zip" -o "$ZIPTMP"
docker exec -i ansnew-cloud-php-1 sh -c 'cat > /tmp/ansnew-verify.zip' < "$ZIPTMP"
ZIP_MD5=$(docker exec ansnew-cloud-php-1 sh -c 'unzip -p /tmp/ansnew-verify.zip box/blob.bin | md5sum' 2>/dev/null | awk '{print $1}')
docker exec ansnew-cloud-php-1 rm -f /tmp/ansnew-verify.zip
rm -f "$ZIPTMP"
check "zip entry md5 matches source (via API)" "$SRC_MD5" "$ZIP_MD5"

echo "== at-rest encryption =="
MAGIC=$(docker exec ansnew-cloud-php-1 sh -c 'head -c 8 /srv/storage/local/box/blob.bin' 2>/dev/null)
check "stored file carries encryption magic" "ANSNEWC1" "$MAGIC"

# Upload a file with a distinctive marker: the marker must be absent from the
# bytes on disk (ciphertext) but present after downloading through the API.
printf 'ANSNEW_PLAINTEXT_MARKER_12345\n' > "$WORK/secret.txt"
curl -s -b "$J" -X POST "$BASE/api/upload/local" \
  -H "X-CSRF-Token: $CSRF" -F "path=/box" -F "conflict=overwrite" \
  -F "file=@$WORK/secret.txt" >/dev/null
ON_DISK=$(docker exec ansnew-cloud-php-1 sh -c 'grep -c ANSNEW_PLAINTEXT_MARKER_12345 /srv/storage/local/box/secret.txt 2>/dev/null || true' | tr -d '\r')
check "plaintext marker absent from stored bytes" "0" "$ON_DISK"
DL=$(curl -s -b "$J" "$BASE/api/fs/local/download?path=/box/secret.txt")
check "marker present after download" "true" "$(echo "$DL" | grep -q ANSNEW_PLAINTEXT_MARKER_12345 && echo true || echo false)"

# The API must report the PLAINTEXT size (from the header), not the ciphertext length.
SRC_BYTES=$(wc -c < "$WORK/blob.bin" | tr -d ' ')
API_SIZE=$(curl -s -b "$J" "$BASE/api/fs/local/stat?path=/box/blob.bin" | grep -oE '"size":[0-9]+' | head -1 | sed 's/.*://')
check "API reports plaintext size, not ciphertext" "$SRC_BYTES" "$API_SIZE"

echo "== trash -> list -> restore round trip =="
curl -s -b "$J" -X POST "$BASE/api/fs/local/delete" \
  -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
  -d '{"path":"/box/blob.bin","permanent":false}' >/dev/null
GONE=$(curl -s -b "$J" "$BASE/api/fs/local/stat?path=/box/blob.bin" | grep -oE '"ok":(true|false)' | head -1)
check "file gone after trash" '"ok":false' "$GONE"

TID=$(curl -s -b "$J" "$BASE/api/trash/local" | grep -oE '"id":[0-9]+' | head -1 | sed 's/.*://')
check "trash has 1 item" "true" "$([ -n "$TID" ] && echo true || echo false)"

curl -s -b "$J" -X POST "$BASE/api/trash/local/restore" \
  -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d "{\"id\":$TID}" >/dev/null
BACK2=$(curl -s -b "$J" "$BASE/api/fs/local/download?path=/box/blob.bin" -o "$WORK/back2.bin"; md5sum "$WORK/back2.bin" | awk '{print $1}')
check "restored file md5 matches" "$SRC_MD5" "$BACK2"

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
