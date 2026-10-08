# Backup and restore

There are **two different things** called "backup" here, and you need both.

| | What it captures | Where it lives | How to run |
|---|---|---|---|
| **Ops snapshot** (`ansnew:backup`) | SQLite database, `data/keys/*` (master keys), `.env` | `$BACKUP_HOST_PATH` | `./scripts/backup.sh` |
| **Drive backup** (Backup page in the UI) | the *contents* of a drive, file by file | a destination drive you pick | the app's Backup view |

The UI feature copies files; it does **not** capture the database, the users, the
shares, the settings, or the encryption keys. That is why the ops snapshot
exists — without it, a dead data volume means a fresh install, and a lost
`file.key` means every encrypted file is gone forever.

---

## What must be preserved

| Item | Location | Lost ⇒ |
|------|----------|--------|
| SQLite database | `data_volume` → `/var/www/data/ansnew.sqlite` | every user, share, setting, job, audit row |
| `app.key` | `data_volume` → `/var/www/data/keys/app.key` | stored connection secrets (S3/FTP/SFTP/SMB) unreadable |
| `file.key` | `data_volume` → `/var/www/data/keys/file.key` | **every encrypted local file permanently unreadable** |
| `.env` | project root | configuration (recoverable, but tedious) |
| Encrypted files | `$STORAGE_HOST_PATH` (default `./storage-root`) | the file contents themselves |
| Remote drives | S3/R2/FTP/SFTP/SMB | held by the provider — not in your backups |

`data_volume` is a Docker named volume. `docker compose down -v` **deletes it**.

---

## Taking a snapshot

```bash
./scripts/backup.sh
```

That runs `ansnew:backup --out=/backups` inside the php container and prunes
snapshots older than `BACKUP_RETENTION_DAYS` (default 14) on the host.

Each snapshot directory contains:

```
ansnew-backup-YYYYmmdd-HHMMSS/
├── ansnew.sqlite     consistent copy (VACUUM INTO, integrity-checked)
├── keys/             app.key, file.key, ws.secret  (0600)
├── env.txt           your .env                     (0600)
└── MANIFEST.txt
```

Nightly cron:

```bash
crontab -e
# 0 3 * * * /srv/ansnew-cloud/scripts/backup.sh >> /var/log/ansnew-backup.log 2>&1
```

> The snapshot contains your **master keys and `.env`** — i.e. everything needed
> to decrypt your files. Store it encrypted and **off-box**. A backup that only
> lives on the same disk does not survive a dead disk.

The file contents are **not** in the snapshot; copy `$STORAGE_HOST_PATH`
separately (e.g. `rsync`/`restic` to another host or bucket), or use the UI's
drive backup.

---

## Restoring

Restoring replaces the live database. Do it with the app **stopped** so nothing
is writing while the file is swapped.

```bash
cd /srv/ansnew-cloud

# 1. Stop everything that writes.
docker compose down

# 2. Restore the database + keys.
docker compose up -d php
docker compose exec php php bin/console.php ansnew:restore \
    --from=/backups/ansnew-backup-20261008-030000 --yes

# 3. Verify, then bring the rest up.
docker compose exec php php bin/console.php ansnew:db-check
docker compose up -d
```

If you also lost the file contents, copy `$STORAGE_HOST_PATH` back from your
off-box copy **before** step 3.

`ansnew:restore` refuses to run without `--yes` and refuses while a job is still
`running` (the worker would be writing to the file being replaced).

### Manual restore (if the CLI is unavailable)

```bash
docker compose down
docker run --rm -v ansnew-cloud_data_volume:/data -v /backups:/b alpine \
  sh -c 'cp /b/<snapshot>/ansnew.sqlite /data/ansnew.sqlite && \
         rm -f /data/ansnew.sqlite-wal /data/ansnew.sqlite-shm && \
         cp /b/<snapshot>/keys/* /data/keys/ && chmod 600 /data/keys/*'
docker compose up -d
```

---

## Practise it

A restore you have never tested is not a backup. Once a quarter:

1. `./scripts/backup.sh`
2. Bring up a throwaway copy (`docker compose -p ansnew-test ...` with a scratch
   volume), restore into it, and confirm you can log in and see your files.
3. Delete the throwaway stack.

---

## Disaster scenarios

| Lost | Recoverable? |
|------|--------------|
| A file deleted by a user | Yes — Trash (30-day retention), or the snapshot |
| The database | Yes — restore the snapshot; files stay put |
| `data_volume` (but you have a snapshot) | Yes — restore DB + keys, files are untouched |
| `file.key` with no snapshot | **No.** The ciphertext is unrecoverable. |
| `storage-root/` with no off-box copy | **No.** |
| `app.key` with no snapshot | Connection secrets must be re-entered; files are fine |
