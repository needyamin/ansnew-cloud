# ANSNEW CLOUD NAS service: a small Samba server that exposes the file manager's
# _inbox folder as a writable SMB share, so Windows "Map Network Drive" and mobile
# SMB apps can drop files straight into the app. Files land in the same host bind
# mount the app lists, so they appear in the file manager immediately; a separate
# nas-watch service imports them (encrypt-at-rest + rate-limited queue).
FROM alpine:3.20

# samba = smbd/nmbd; samba-common-tools = smbpasswd/pdbedit; gettext = envsubst
# (used to template the share name + user into smb.conf at startup).
RUN apk add --no-cache samba samba-common-tools gettext shadow

# Fixed uid/gid 82 — matches php-fpm's www-data on Alpine — so files written over
# SMB are owned compatibly with the app/worker containers that read+write them.
# In this Alpine base uid 82 is free, so a plain -u 82 assignment succeeds.
RUN addgroup ansnew 2>/dev/null || true \
 && adduser -D -u 82 -G ansnew ansnew

COPY docker/nas/smb.conf.template /etc/samba/smb.conf.template
COPY docker/nas/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# SMB (445), NetBIOS session (139), NetBIOS name service (137/udp, 138/udp).
EXPOSE 137/udp 138/udp 139 445

ENTRYPOINT ["/entrypoint.sh"]
