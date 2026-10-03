# syntax=docker/dockerfile:1

FROM nginxinc/nginx-unprivileged:1.27-alpine

COPY docker/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY public/ /var/www/public/
COPY public/healthz /usr/share/nginx/html/healthz

USER 101
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --retries=10 --start-period=15s \
    CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1

CMD ["nginx", "-g", "daemon off;"]
