# syntax=docker/dockerfile:1

FROM nginxinc/nginx-unprivileged:1.27-alpine

# The base image sets `USER 101`, so apk cannot write its database — drop to root
# for the install and back to 101 before anything is served.
USER root

# openssl is needed by the startup script to mint a placeholder certificate when
# no real one is mounted, so the container can always boot.
# See docker/nginx/40-ansnew-tls.sh.
RUN apk add --no-cache openssl

# The site config is copied to TWO places on purpose:
#   /etc/nginx/ansnew/default.conf  — source of truth. Bind-mounted read-only by
#                                     docker-compose, and baked here as a fallback
#                                     for running the image without the mount.
#   /etc/nginx/conf.d/default.conf  — what nginx actually loads. Rewritten at
#                                     startup so the TLS certificate paths can be
#                                     redirected when no certificate is present.
COPY docker/nginx/default.conf /etc/nginx/ansnew/default.conf
COPY docker/nginx/default.conf /etc/nginx/conf.d/default.conf

# Runs before nginx starts (the base image executes /docker-entrypoint.d/*.sh).
COPY docker/nginx/40-ansnew-tls.sh /docker-entrypoint.d/40-ansnew-tls.sh
RUN chmod +x /docker-entrypoint.d/40-ansnew-tls.sh

COPY public/ /var/www/public/
COPY public/healthz /usr/share/nginx/html/healthz

USER 101
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --retries=10 --start-period=15s \
    CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1

CMD ["nginx", "-g", "daemon off;"]
