#!/usr/bin/env bash
# ANSNEW CLOUD encryption round-trip + tamper-detection test.
#
# Exercises FileCipher/EncryptedFormat directly inside the php container:
#   - multi-chunk round-trip (md5 must match)
#   - header reports the PLAINTEXT size
#   - a flipped ciphertext byte must fail authentication
#   - a truncated file must fail
#   - empty files round-trip
#   - plaintext files are not misdetected as encrypted
#   - the wrong master key must not unwrap a data key
#
# Usage: bash tools/crypto-test.sh
set -uo pipefail

PASS=0; FAIL=0
check() { # label expected actual
  if [ "$2" = "$3" ]; then echo "  PASS  $1"; PASS=$((PASS+1));
  else echo "  FAIL  $1  (expected=$2 got=$3)"; FAIL=$((FAIL+1)); fi
}

OUT=$(docker exec -i ansnew-cloud-php-1 php <<'PHP'
<?php
require '/var/www/app/vendor/autoload.php';
use App\Config\Config;
use App\Storage\Encryption\EncryptedFormat;
use App\Storage\Encryption\FileCipher;

Config::i();
$dir = '/var/www/data/tmp/cryptotest-' . bin2hex(random_bytes(4));
@mkdir($dir, 0770, true);
$out = [];

function enc(string $src, string $dst): int {
    $in = fopen($src, 'rb');
    $n = FileCipher::encryptStreamToFile($in, $dst, null, 'bin');
    fclose($in);
    return $n;
}

// ---- 1. multi-chunk round trip (3.5 MiB => 4 chunks at 1 MiB) ----
$plain = $dir . '/plain.bin';
$cipher = $dir . '/plain.enc';
$data = random_bytes(3 * 1024 * 1024 + 512 * 1024);
file_put_contents($plain, $data);
$written = enc($plain, $cipher);
$fmt = FileCipher::readHeader($cipher);
$out[] = 'written_bytes=' . $written;
$out[] = 'md5_in=' . md5($data);
$out[] = 'chunks=' . ($fmt ? $fmt->chunkCount() : -1);
$out[] = 'hdr_size=' . ($fmt ? $fmt->plaintextSize : -1);
$out[] = 'cipher_bytes=' . filesize($cipher);
$out[] = 'expected_cipher=' . EncryptedFormat::ciphertextSize(strlen($data), $fmt->headerLen);

// decrypt via the stream wrapper
$fh = App\Storage\Encryption\DecryptStreamWrapper::open($cipher, $fmt, FileCipher::unwrapKey($fmt));
$round = stream_get_contents($fh);
fclose($fh);
$out[] = 'md5_out=' . md5($round);
$out[] = 'size_out=' . strlen($round);

// ---- 2. no plaintext leaks in the ciphertext ----
$raw = file_get_contents($cipher);
$needle = substr($data, 0, 64);
$out[] = 'plaintext_leak=' . (strpos($raw, $needle) === false ? 'none' : 'FOUND');
$out[] = 'magic_ok=' . (substr($raw, 0, 8) === 'ANSNEWC1' ? 'yes' : 'no');

// ---- 3. tamper detection: flip a ciphertext byte ----
$tampered = $dir . '/tamper.enc';
copy($cipher, $tampered);
$f = fopen($tampered, 'r+b');
$off = $fmt->headerLen + 12;
fseek($f, $off);
$b = fread($f, 1);
fseek($f, $off);
fwrite($f, chr(ord($b) ^ 0xFF));
fclose($f);
$tf = FileCipher::readHeader($tampered);
try {
    $h = App\Storage\Encryption\DecryptStreamWrapper::open($tampered, $tf, FileCipher::unwrapKey($tf));
    stream_get_contents($h);
    fclose($h);
    $out[] = 'tamper=' . 'NOT_DETECTED';
} catch (\Throwable $e) {
    $out[] = 'tamper=' . 'detected';
}

// ---- 4. truncation detection ----
$trunc = $dir . '/trunc.enc';
copy($cipher, $trunc);
$sz = filesize($trunc);
$t = fopen($trunc, 'r+b'); ftruncate($t, $sz - 40); fclose($t);
$rf = FileCipher::readHeader($trunc);
try {
    $h = App\Storage\Encryption\DecryptStreamWrapper::open($trunc, $rf, FileCipher::unwrapKey($rf));
    stream_get_contents($h);
    fclose($h);
    $out[] = 'truncate=' . 'NOT_DETECTED';
} catch (\Throwable $e) {
    $out[] = 'truncate=' . 'detected';
}

// ---- 5. empty file round-trip ----
$empty = $dir . '/empty.bin';
file_put_contents($empty, '');
$ec = $dir . '/empty.enc';
$n = enc($empty, $ec);
$ef = FileCipher::readHeader($ec);
$h = App\Storage\Encryption\DecryptStreamWrapper::open($ec, $ef, FileCipher::unwrapKey($ef));
$eout = stream_get_contents($h);
fclose($h);
$out[] = 'empty_written=' . $n;
$out[] = 'empty_read=' . strlen($eout);
$out[] = 'empty_size=' . $ef->plaintextSize;

// ---- 6. plaintext file is not misdetected ----
$out[] = 'plain_detect=' . (FileCipher::isEncrypted($plain) ? 'WRONG' : 'correct');
$out[] = 'cipher_detect=' . (FileCipher::isEncrypted($cipher) ? 'correct' : 'WRONG');

// ---- 7. wrong key must not unwrap ----
$realKey = Config::i()->fileKey();
$wrong = new ReflectionProperty(Config::class, 'fileKeyCache');
$wrong->setAccessible(true);
$cfg = Config::i();
$wrong->setValue($cfg, str_repeat('ab', 32));
FileCipher::forgetKey();
try {
    FileCipher::unwrapKey($fmt);
    $out[] = 'wrong_key=' . 'NOT_REJECTED';
} catch (\Throwable $e) {
    $out[] = 'wrong_key=' . 'rejected';
}
$wrong->setValue($cfg, $realKey);
FileCipher::forgetKey();

// cleanup
foreach (glob($dir . '/*') as $f) { @unlink($f); }
@rmdir($dir);

echo implode("\n", $out), "\n";
PHP
)

get() { echo "$OUT" | grep -E "^$1=" | head -1 | cut -d= -f2-; }

echo "== encryption round-trip =="
check "plaintext byte count returned" "3670016" "$(get written_bytes)"
check "chunk count (3.5 MiB / 1 MiB)" "4" "$(get chunks)"
check "header reports plaintext size" "3670016" "$(get hdr_size)"
check "decrypted size matches" "3670016" "$(get size_out)"
check "decrypted md5 matches source" "$(get md5_in)" "$(get md5_out)"
check "on-disk size == header + payload" "$(get expected_cipher)" "$(get cipher_bytes)"

echo "== confidentiality =="
check "container magic present" "yes" "$(get magic_ok)"
check "no plaintext in ciphertext" "none" "$(get plaintext_leak)"

echo "== integrity =="
check "tampered chunk rejected" "detected" "$(get tamper)"
check "truncated file rejected" "detected" "$(get truncate)"
check "wrong master key rejected" "rejected" "$(get wrong_key)"

echo "== edge cases =="
check "empty file encrypts to 0 bytes" "0" "$(get empty_written)"
check "empty file decrypts to 0 bytes" "0" "$(get empty_read)"
check "empty header size is 0" "0" "$(get empty_size)"
check "plaintext not misdetected" "correct" "$(get plain_detect)"
check "ciphertext detected" "correct" "$(get cipher_detect)"

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
