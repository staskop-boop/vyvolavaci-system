# Server vyvolávacieho systému AdNa (aplikácia Sestra, Tablet, Obrazovka) v kontajneri.
# Zostavenie: docker build -t adna .   Spustenie: pozri deploy/docker-compose.yml
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    TZ=Europe/Bratislava \
    ADNA_PORT=8080 \
    ADNA_HOST=0.0.0.0 \
    ADNA_DATA_DIR=/data

WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server/src ./src
COPY server/scripts ./scripts
COPY apps/sestra/web /app/apps/sestra/web
COPY apps/tablet/web /app/apps/tablet/web
COPY apps/tv/web /app/apps/tv/web
COPY shared /app/shared

RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/sestra/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
