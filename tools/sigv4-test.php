<?php

declare(strict_types=1);

/**
 * AWS Signature V4 verification against the published test vector.
 *
 * A signing bug in the S3 adapter would otherwise only surface as a 403 from a
 * live bucket, which needs real credentials to reproduce. This checks the
 * canonical-request → string-to-sign → signing-key chain against the worked
 * example in AWS's own documentation, so it can run in CI with no network.
 *
 * Vector source: "Examples of the complete Signature Version 4 signing process"
 * — GET Object from examplebucket, with a Range header.
 *
 * Usage: php tools/sigv4-test.php
 */

require dirname(__DIR__) . '/vendor/autoload.php';

use App\Storage\Adapters\S3Adapter;

$accessKey = 'AKIAIOSFODNN7EXAMPLE';
$secretKey = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
$region = 'us-east-1';
$amzDate = '20130524T000000Z';

// The canonical request is:
//   GET
//   /test.txt
//   (empty query)
//   host:examplebucket.s3.amazonaws.com
//   range:bytes=0-9
//   x-amz-content-sha256:<empty payload hash>
//   x-amz-date:20130524T000000Z
//
//   host;range;x-amz-content-sha256;x-amz-date
//   <empty payload hash>
$headers = [
    'host' => 'examplebucket.s3.amazonaws.com',
    'range' => 'bytes=0-9',
    'x-amz-content-sha256' => hash('sha256', ''),
    'x-amz-date' => $amzDate,
];
ksort($headers);

$expected = 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,'
    . 'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,'
    . 'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41';

$actual = S3Adapter::buildAuthorization(
    'GET',
    '/test.txt',
    '',
    $headers,
    hash('sha256', ''),
    $amzDate,
    $region,
    $accessKey,
    $secretKey
);

$pass = 0;
$fail = 0;
$check = static function (string $label, bool $ok, string $extra = '') use (&$pass, &$fail): void {
    if ($ok) {
        echo "  PASS  {$label}\n";
        $pass++;
    } else {
        echo "  FAIL  {$label}" . ($extra !== '' ? "  ({$extra})" : '') . "\n";
        $fail++;
    }
};

$check('signature matches the AWS published vector', $actual === $expected,
    "\n    expected: {$expected}\n    actual:   {$actual}");

// The same vector with a different secret must NOT match — guards against the
// signing key being computed but never actually applied.
$wrong = S3Adapter::buildAuthorization(
    'GET', '/test.txt', '', $headers, hash('sha256', ''), $amzDate, $region,
    $accessKey, 'not-the-right-secret'
);
$check('a different secret produces a different signature', $wrong !== $expected);

// Payload hash must participate: the same request with a non-empty payload
// hash is a different signature.
$withBody = S3Adapter::buildAuthorization(
    'GET', '/test.txt', '', $headers, hash('sha256', 'body'), $amzDate, $region,
    $accessKey, $secretKey
);
$check('the payload hash is part of the signature', $withBody !== $expected);

// Region participates too.
$otherRegion = S3Adapter::buildAuthorization(
    'GET', '/test.txt', '', $headers, hash('sha256', ''), $amzDate, 'eu-west-1',
    $accessKey, $secretKey
);
$check('the region is part of the signature', $otherRegion !== $expected);

// A query string must be canonicalised into the signature.
$withQuery = S3Adapter::buildAuthorization(
    'GET', '/', 'list-type=2&max-keys=1', $headers, hash('sha256', ''), $amzDate,
    $region, $accessKey, $secretKey
);
$check('the canonical query string is part of the signature', $withQuery !== $expected);
$check('authorization is well formed',
    str_starts_with($withQuery, 'AWS4-HMAC-SHA256 Credential=')
    && str_contains($withQuery, 'SignedHeaders=')
    && str_contains($withQuery, 'Signature='));

echo "\nSIGV4 RESULT: {$pass} passed, {$fail} failed\n";
exit($fail > 0 ? 1 : 0);
