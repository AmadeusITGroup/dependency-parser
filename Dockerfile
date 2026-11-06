# syntax=docker/dockerfile:1

FROM node:24-trixie-slim AS backend-build
WORKDIR /app/backend
ENV NPM_CONFIG_REGISTRY=https://registry.npmjs.org
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-trixie-slim AS frontend-build
WORKDIR /app/frontend
ENV NPM_CONFIG_REGISTRY=https://registry.npmjs.org
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:24-trixie-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git openssh-client \
    && rm -rf /var/lib/apt/lists

WORKDIR /app/backend
ENV NODE_ENV=production \
    DATASTORE=json \
    PORT=3000 \
    FRONTEND_DIST=/app/frontend

COPY --from=backend-build --chown=node:node /app/backend/package.json ./
COPY --from=backend-build --chown=node:node /app/backend/node_modules ./node_modules
COPY --from=backend-build --chown=node:node /app/backend/dist ./dist
COPY --from=frontend-build --chown=node:node /app/frontend/dist/frontend/browser /app/frontend
RUN mkdir -p /app/backend/data && chown node:node /app/backend/data

USER node
VOLUME ["/app/backend/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/api/health').then(async response => { if (!response.ok || (await response.json()).status !== 'ok') throw new Error('Unhealthy API'); }).catch(error => { console.error(error); process.exit(1); })"
CMD ["node", "dist/index.js"]
