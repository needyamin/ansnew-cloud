# Deploying ANSNEW CLOUD on a Linux VPS

Target: a Linux server with a public IP, reached at `https://<your-domain>`.

The stack is five containers behind one nginx: `nginx` (SPA + TLS + FastCGI),
`php` (php-fpm), `worker` (background jobs), `ws` (WebSocket notifications), and
optionally `db` (MariaDB — **not** used here; this guide keeps SQLite).

> **Do not enable the `nas` (SMB, port 445) or `mysql` compose profiles on a
> public host.** They are for a trusted LAN or development only.

---

## 0. What you need

- A VPS (2 vCPU / 2 GB RAM is comfortable for a handful of users; 4 GB if you
  expect large concurrent downloads — see the sizing note in step 5).
- A domain you can add DNS records for.
- Docker Engine + the Compose plugin.
- `certbot` (the TLS script installs it if missing).

---

## 1. DNS

Point the domain at the server **before** requesting a certificate:

| Type | Name | Value |
|------|------|-------|
| A | `cloud.example.com` | your server's IPv4 |
| AAAA | `cloud.example.com` | your server's IPv6 (if any) |

Verify with `dig +short cloud.example.com`.

---

## 2. Firewall

Only SSH, HTTP and HTTPS should be reachable:

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp      # ACME challenge + redirect to HTTPS
ufw allow 443/tcp     # the app
ufw enable
```

Ports **8080/8443/9443 must not be published** in production — nginx listens on
those only inside the container network.

---

## 3. Get the code

```bash
git clone <your-repo> /srv/ansnew-cloud
cd /srv/ansnew-cloud
```

## 4. Install

### Option A — the installer (recommended)

```bash
sudo ./install.sh --domain cloud.example.com
```

It installs Docker if needed, writes a hardened `.env` (random admin password,
`APP_URL=https://<domain>`, `SESSION_SECURE_COOKIE=true`, ports 80/443,
`PASSWORD_MIN_LENGTH=10`), opens the firewall, builds and starts the stack, waits
for health, and writes the generated credentials to
`/root/ANSNEW-CREDENTIALS.txt`. Use `--tls` to also run the certificate step.

### Option B — manual

```bash
cp .env.example .env
$EDITOR .env
```

Set at minimum:

```ini
APP_URL=https://cloud.example.com
SESSION_SECURE_COOKIE=true
HTTP_PORT=80
HTTPS_PORT=443
ADMIN_PASSWORD=            # leave empty -> a strong one is generated and logged
PASSWORD_MIN_LENGTH=10
CERTS_HOST_PATH=/etc/ansnew/tls
ACME_WEBROOT_HOST_PATH=/var/www/ansnew-acme
TRUST_PROXY=true
```

`APP_KEY`, `WS_SECRET` and `data/keys/file.key` are generated on first boot.
**Back them up** — see [BACKUP-RESTORE.md](BACKUP-RESTORE.md).

---

## 5. First boot

```bash
docker compose up -d --build
docker compose ps               # all services should be healthy
```

**nginx starts even with no certificate.** If `CERTS_HOST_PATH` is empty it
generates a self-signed placeholder at startup and logs a loud warning, so the
stack always comes up — and the plain-HTTP listener stays reachable, which is what
lets Let's Encrypt's HTTP-01 challenge be answered at all. (The placeholder lives
inside the container, so it is regenerated on every recreate: a fresh browser
warning each time.)

For a stable certificate on the host — this is what `install.sh` does for you:

```bash
./scripts/make-cert.sh          # self-signed, 10 years; reads CERTS_HOST_PATH from .env
docker compose restart nginx
```

`make-cert.sh` refuses to overwrite an existing certificate unless you pass
`--force`, so it cannot clobber a real one.

Read the generated admin password (only printed once):

```bash
docker compose logs php | grep -i password
```

> **Sizing:** php-fpm runs `pm.max_children = 12` (`docker/php/fpm-pool.conf`).
> Media previews and downloads hold a worker for the whole transfer, so a few
> concurrent large downloads can use the pool. Keep
> `pm.max_children × typical per-request memory` inside the `mem_limit` in
> `docker-compose.yml` (2 GB). On a 2 GB VPS lower both, e.g. `max_children = 6`
> and `mem_limit: 1g`.

---

## 6. Real TLS

```bash
./scripts/init-letsencrypt.sh cloud.example.com admin@example.com
```

This obtains the certificate via the HTTP-01 webroot challenge (no downtime) and
reloads nginx with it. Then add renewal:

```bash
crontab -e
# 0 3 * * * /srv/ansnew-cloud/scripts/renew-cert.sh >> /var/log/ansnew-cert.log 2>&1
```

Verify: `curl -I https://cloud.example.com` shows `Strict-Transport-Security`,
and `curl -I http://cloud.example.com` answers `301` to HTTPS.

**HSTS is sticky.** It starts at `max-age=300` in
`docker/nginx/default.conf`. Once you are sure TLS works, raise it to
`max-age=31536000` — after that, browsers refuse plain HTTP for this host.

---

## 7. Verify the deployment

```bash
# HTTPS + redirect + headers
curl -sI https://cloud.example.com | grep -iE 'HTTP/|strict-transport|content-security'
curl -sI http://cloud.example.com  | head -1

# Database integrity
docker compose exec php php bin/console.php ansnew:db-check

# Real client IP is honoured (rate limiting / lockout / audit key on it).
# A spoofed X-Forwarded-For must NOT change the IP the app records.
curl -s -H 'X-Forwarded-For: 1.2.3.4' https://cloud.example.com/api/bootstrap >/dev/null
docker compose exec php php -r 'require "vendor/autoload.php";
  echo App\Core\Database::i()->scalar("SELECT ip FROM audit_log ORDER BY id DESC LIMIT 1"), "\n";'
# -> should be YOUR real IP, never 1.2.3.4
```

Then log in and exercise: upload a large file, download it back, preview a
video, run a folder download, and confirm progress appears in real time.

---

## Upgrading

```bash
cd /srv/ansnew-cloud
./scripts/backup.sh                    # always take a snapshot first
git pull --ff-only                     # without this you rebuild the OLD source
docker compose build
docker compose up -d --force-recreate  # migrations run automatically on boot
docker compose ps
```

`--force-recreate` matters here too: the built tag is always `ansnew/php:latest`,
so Compose sees an unchanged tag string and may keep the container running the
previous build. Skipping `git pull` is the other classic failure — `build` then
happily bakes whatever checkout is on disk.

Migrations are additive and idempotent (`Database::applyAdditiveMigrations()`),
so an upgrade never drops data. Take a backup anyway — the pre-upgrade snapshot
is your rollback.

### Upgrading from published images

If you deploy pre-built images instead of building on the server (see
[Docker images](../README.md#docker-images)), set the image references in `.env`
and pull:

```bash
./scripts/backup.sh
# bump the tags in .env, then:
docker compose pull
docker compose up -d --no-build --force-recreate
docker compose ps
```

Two flags, both required, and both easy to lose:

- `--no-build` — the services also declare a `build:` context, so without it
  Compose rebuilds locally and ignores what you just pulled.
- `--force-recreate` — **without this the running container keeps the OLD
  image.** Compose decides whether to recreate a container by hashing its
  config, and an unchanged tag *string* hashes the same even when that tag now
  points at a completely different image. `pull` updates the tag; only
  `--force-recreate` makes the container actually use it.

> **The `IMAGE_*` defaults are local-only names.** `.env.example` ships
> `IMAGE_PHP=ansnew/php` etc., which is what `docker compose build` produces
> locally — those names do not exist on Docker Hub, so `docker compose pull`
> fails with `pull access denied for ansnew/php, repository does not exist`
> and downloads nothing. To upgrade from the registry you MUST point them at
> the published repository, e.g. `IMAGE_PHP=needyamin/ansnew-cloud:php-1.0.0`.
> On the server also run `docker login` first.

Verify the running container really got the new image — the image ID in
`docker compose ps` must match `docker images` for the pulled tag:

```bash
docker compose images          # repo tag per service
docker inspect -f '{{.Image}}' ansnew-cloud-php-1
```

### Rollback

Two ways, depending on how you deploy:

```bash
# Built on the server -> revert the code
git log --oneline -5
git checkout <previous-commit>
docker compose build && docker compose up -d
```

```bash
# Published images -> revert the tag in .env and pull it back
#   IMAGE_PHP=youruser/ansnew-cloud:php-1.1.0   (was ...:php-1.2.0)
docker compose pull && docker compose up -d --no-build --force-recreate
```

This is why version tags beat `latest` on a real deployment — `latest` has nothing
to roll back to. Whichever route you take, keep the pre-upgrade snapshot: if a
migration did something unexpected, restore it with
`docker compose exec php php bin/console.php ansnew:restore --from=/backups/<dir> --yes`
(see [BACKUP-RESTORE.md](BACKUP-RESTORE.md)).

---

## Common operations

| Task | Command |
|------|---------|
| Logs (app + worker) | `docker compose logs -f php worker` |
| Reload nginx after a cert change | `docker compose exec nginx nginx -s reload` |
| Reset a password | `docker compose exec php php bin/console.php ansnew:reset-password --random` |
| Encryption status | `docker compose exec php php bin/console.php ansnew:crypto-status` |
| Backup now | `./scripts/backup.sh` |
| Stop / start | `docker compose down` / `docker compose up -d` |

> **Never run `docker compose down -v`.** It deletes the `data_volume`, which
> holds the database **and the master encryption keys** — every encrypted file in
> `storage-root/` would become permanently unreadable.

---

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| 502 from nginx | php container restarted; nginx caches its IP. `docker compose restart nginx` |
| `413 Request Entity Too Large` | body limit — must match in both nginx listeners and php.ini |
| Login works but actions 403 | `APP_URL` doesn't match the host you're using (same-origin check) |
| Cookie not sent | `SESSION_SECURE_COOKIE=true` while browsing over plain HTTP |
| Certificate not renewed | check the cron entry and `certbot renew --dry-run` |
| Uploads stall | check `docker compose logs php` and the worker log |

---

## Security posture (be aware)

- **Encrypted at rest:** file contents on `local` mounts (AES-256-GCM) and saved
  connection secrets.
- **Not encrypted by the app:** files on remote drives (S3/R2, FTP, SFTP, SMB,
  WebDAV — the provider handles at-rest), file names/paths, the SQLite database,
  thumbnails, and `.env`.
- The keys live in the `data_volume`; **losing them is unrecoverable**. Back them
  up (step 4 / BACKUP-RESTORE.md).
- Full-disk/volume encryption on the host is the baseline that covers everything
  above and is **your** step — it cannot be done from inside the app.
