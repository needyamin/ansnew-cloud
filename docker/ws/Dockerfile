# syntax=docker/dockerfile:1

FROM node:20-alpine

WORKDIR /opt/ansnew-ws

COPY ws-server/package.json ws-server/package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --chown=node:node ws-server/server.js ./
COPY --chown=node:node ws-server/lib ./lib

USER node
EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=5s --retries=10 --start-period=20s \
    CMD node -e "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
