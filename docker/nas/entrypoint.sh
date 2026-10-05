#!/bin/sh
# ANSNEW CLOUD NAS entrypoint: create the SMB login account, ensure the inbox exists
# (owned by the forced SMB user, uid 82, so the app containers can read+write it),
# render smb.conf from env, then run smbd in the foreground.
set -e

export NAS_SHARE_NAME="${NAS_SHARE_NAME:-ansnew}"
export NAS_USER="${NAS_USER:-ansnew}"
export NAS_PASS="${NAS_PASS:-change-me}"

# Create the SMB login account FIRST: a system user (for tdbsam) + its SMB password.
# This must happen before the chown below, which references this user.
adduser -D "$NAS_USER" 2>/dev/null || true
echo "$NAS_USER:$NAS_PASS" | chpasswd
printf '%s\n%s\n' "$NAS_PASS" "$NAS_PASS" | smbpasswd -a "$NAS_USER"

# The inbox lives on the shared host bind mount (same dir the app lists as the
# `local` mount), so dropped files show up in the file manager at once. It must be
# owned by the forced SMB user (uid 82) or the app containers cannot read/write it.
mkdir -p /srv/storage/local/_inbox
chown ansnew:ansnew /srv/storage/local/_inbox 2>/dev/null || true
chmod 0775 /srv/storage/local/_inbox

# Template the share name + allowed user into the real config.
envsubst '${NAS_SHARE_NAME} ${NAS_USER}' < /etc/samba/smb.conf.template > /etc/samba/smb.conf

echo "[ansnew-nas] share '${NAS_SHARE_NAME}' for user '${NAS_USER}' listening on :445"

# nmbd provides LAN NetBIOS name discovery (best-effort, daemonized).
nmbd -D 2>/dev/null || true

# Run smbd in the foreground as a child and have this script wait on it. Running it
# as a backgrounded child (rather than exec as PID 1) keeps the container alive on
# this Samba build; the trap forwards Docker's SIGTERM for a clean shutdown.
smbd -F --configfile=/etc/samba/smb.conf &
SMBD_PID=$!
trap 'kill -TERM "$SMBD_PID" 2>/dev/null; wait "$SMBD_PID"' TERM INT
wait "$SMBD_PID"
