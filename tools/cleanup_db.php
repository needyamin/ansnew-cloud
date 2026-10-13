<?php
// Run inside the php container against the live SQLite DB.
// Removes every non-local mount (stray 'Viewer Drive' / 'S3 Test' test mounts)
// and every connection no longer referenced by a remaining mount, leaving
// exactly one drive: `local`. Reassigns user home mounts so nothing dangles.

$path = getenv('DB_DATABASE') ?: '/var/www/data/ansnew.sqlite';
echo "DB: {$path}\n";
$pdo = new PDO('sqlite:' . $path, null, null, [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
]);

$before = $pdo->query('SELECT id,name,adapter,connection_id FROM mounts ORDER BY id')->fetchAll();
echo "BEFORE mounts: " . json_encode($before, JSON_PRETTY_PRINT) . "\n";

$local = $pdo->query("SELECT id FROM mounts WHERE name = 'local' LIMIT 1")->fetchColumn();
if ($local === false) {
    fwrite(STDERR, "FATAL: no 'local' mount found; aborting.\n");
    exit(1);
}
echo "local mount id = {$local}\n";

// Reassign any user whose home mount is about to be deleted -> local.
$users = $pdo->query('SELECT id,username,home_mount_id FROM users')->fetchAll();
foreach ($users as $u) {
    if ($u['home_mount_id'] === null) { continue; }
    $name = $pdo->query("SELECT name FROM mounts WHERE id = " . (int)$u['home_mount_id'])->fetchColumn();
    if ($name !== false && $name !== 'local') {
        $pdo->prepare('UPDATE users SET home_mount_id = ? WHERE id = ?')->execute([$local, $u['id']]);
        echo "reassigned user {$u['username']} home_mount_id {$u['home_mount_id']} -> {$local}\n";
    }
}

// Delete stray mounts (mount_grants cascade via FK; shares/trash reference by
// path, not by mount id, so they are harmless leftovers).
$del = $pdo->query("SELECT id,connection_id FROM mounts WHERE name <> 'local'")->fetchAll();
foreach ($del as $m) {
    $pdo->prepare('DELETE FROM mount_grants WHERE mount_id = ?')->execute([$m['id']]);
    $pdo->prepare('DELETE FROM mounts WHERE id = ?')->execute([$m['id']]);
    echo "deleted mount id={$m['id']} (connection_id=" . var_export($m['connection_id'], true) . ")\n";
}

// Connections referenced by remaining mounts are kept; orphans are removed.
$ref = $pdo->query('SELECT DISTINCT connection_id FROM mounts WHERE connection_id IS NOT NULL')->fetchAll(PDO::FETCH_COLUMN);
$conns = $pdo->query('SELECT id,name FROM connections ORDER BY id')->fetchAll();
foreach ($conns as $cn) {
    if (!in_array($cn['id'], $ref, true)) {
        $pdo->prepare('DELETE FROM connections WHERE id = ?')->execute([$cn['id']]);
        echo "deleted connection id={$cn['id']} name={$cn['name']}\n";
    } else {
        echo "kept connection id={$cn['id']} name={$cn['name']} (referenced)\n";
    }
}

$after = $pdo->query('SELECT id,name,adapter FROM mounts ORDER BY id')->fetchAll();
$connsAfter = $pdo->query('SELECT id,name FROM connections ORDER BY id')->fetchAll();
echo "AFTER mounts: " . json_encode($after) . "\n";
echo "AFTER connections: " . json_encode($connsAfter) . "\n";
echo (count($after) === 1 && $after[0]['name'] === 'local') ? "RESULT: OK\n" : "RESULT: CHECK\n";
