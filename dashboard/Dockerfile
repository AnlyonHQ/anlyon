# syntax=docker/dockerfile:1

FROM node:22.23.4-alpine AS build
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
ARG BUILD_NODE_OPTIONS=--max-old-space-size=3072
ENV NODE_OPTIONS=$BUILD_NODE_OPTIONS
RUN corepack enable
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY dashboard/package.json dashboard/
COPY packages/feature-flags/package.json packages/feature-flags/
COPY packages/known-vendors/package.json packages/known-vendors/
RUN pnpm install --frozen-lockfile --filter anlyon-scheduler-ui...

COPY . .
RUN rm -rf dashboard/src/extensions
RUN for name in $(env | sed -n 's/^\(VITE_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$name"; done; \
    pnpm --workspace-concurrency=1 --filter anlyon-scheduler-ui build
RUN mv dashboard/dist /console

FROM caddy:2-alpine

COPY --from=build /console /srv
COPY dashboard/docker/Caddyfile /etc/caddy/Caddyfile
COPY dashboard/docker/entrypoint.sh /usr/local/bin/anlyon-console-entrypoint
RUN chmod +x /usr/local/bin/anlyon-console-entrypoint

ENV ANLYON_API_URL=""
ENV ANLYON_EDITION=community

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:8080/config.js || exit 1

ENTRYPOINT ["/usr/local/bin/anlyon-console-entrypoint"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
