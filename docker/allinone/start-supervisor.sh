#!/bin/sh
#
# ANSNEW CLOUD all-in-one image — the CMD.
#
# Runs AFTER the shared ENTRYPOINT (docker/php/entrypoint.sh) has done the
# app-side bootstrap: data dirs, APP_KEY, migrations, admin bootstrap and
# mount seeding. This script does the nginx-side bootstrap, which must also
# happen before anything serves: point the TLS listener at a real certificate
# when one is mounted, otherwise mint a placeholder so nginx always starts
# (crash-looping on a missing cert made even the plain-HTTP listener
# unreachable — see the header of 40-ansnew-tls.sh for the full story).
#
# Then hand the process tree to supervisord, which stays as PID 1.
set -eu

/usr/local/bin/40-ansnew-tls.sh

exec supervisord -c /etc/supervisord.conf
