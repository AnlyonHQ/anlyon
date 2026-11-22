# syntax=docker/dockerfile:1

FROM node:22.23.4-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /repo

FROM base AS deps

ARG BUILD_NODE_OPTIONS=--max-old-space-size=3072
ENV NODE_OPTIONS=$BUILD_NODE_OPTIONS

RUN apk add --no-cache python3 make g++

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/.npmrc server/
COPY packages/feature-flags/package.json packages/feature-flags/
COPY packages/known-vendors/package.json packages/known-vendors/
COPY packages/mcp-risk/package.json packages/mcp-risk/
COPY sdks/typescript/sdk/package.json sdks/typescript/sdk/
COPY sdks/typescript/mcp-server/package.json sdks/typescript/mcp-server/

RUN pnpm install --frozen-lockfile --filter anlyon-scheduler...

FROM base AS builder

ARG BUILD_NODE_OPTIONS=--max-old-space-size=3072
ENV NODE_OPTIONS=$BUILD_NODE_OPTIONS

COPY --from=deps /repo /repo
COPY . .

RUN pnpm --workspace-concurrency=1 --filter anlyon-scheduler... build

RUN pnpm --filter=anlyon-scheduler --prod --legacy deploy /out

RUN cp -r server/dist /out/dist

RUN for manifest in server/src/extensions/*/extension.json; do \
      [ -e "$manifest" ] || continue; \
      name=$(basename "$(dirname "$manifest")"); \
      if [ ! -f "/out/dist/extensions/$name/index.js" ] || [ ! -f "/out/dist/extensions/$name/extension.json" ]; then \
        echo "Extension '$name' is missing from the build (dist/extensions/$name)." >&2; exit 1; \
      fi; \
    done

RUN rm -rf /out/tests /out/docs /out/contracts /out/scripts \
    /out/Dockerfile /out/docker-compose.yml \
    /out/vitest.config.ts /out/tsup.config.ts /out/openapitools.json

FROM node:22.23.4-alpine AS production

RUN apk add --no-cache postgresql-client

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 scheduler

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4000
ENV NODE_OPTIONS=--experimental-sqlite

ARG BUILD_SHA=unknown
ARG BUILD_TIME=
ENV BUILD_SHA=$BUILD_SHA
ENV BUILD_TIME=$BUILD_TIME

COPY --from=builder --chown=scheduler:nodejs /out ./

RUN chmod +x /app/wait-for-db.sh

RUN mkdir -p /app/data && chown scheduler:nodejs /app/data

USER scheduler

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider --header="X-Forwarded-Proto: https" http://127.0.0.1:4000/health/ready || exit 1

CMD ["sh", "/app/wait-for-db.sh"]
