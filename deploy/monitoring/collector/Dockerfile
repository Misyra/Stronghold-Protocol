# SPDX-License-Identifier: GPL-3.0-or-later
# The healthz → Prometheus collector (index.mjs, metrics.mjs): Node 24 built-ins only, no npm install, runs as `node`
# on a read-only root filesystem (compose.monitoring.yaml). Build context: this folder only.
ARG NODE_IMAGE=node:24.22.0-alpine3.24
FROM ${NODE_IMAGE}
WORKDIR /app
COPY index.mjs metrics.mjs ./
ENV NODE_ENV=production
USER node
CMD ["node", "index.mjs"]
