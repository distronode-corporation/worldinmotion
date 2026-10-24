# syntax=docker/dockerfile:1.7
# The worldinmotion relay. Build from the repository root. The base image is pinned by digest
# on both FROM lines, written out rather than through an ARG because Dependabot (the `docker`
# entry in .github/dependabot.yml) reads only literal FROM lines; it updates both together.
#
#   docker build -f packages/relay-node/Dockerfile -t wim-relay .
#
#   docker run -p 8787:8787 -v wim-relay:/data -e WIM_RELAY_URLS=wss://relay.example \
#     -e WIM_CREATE_KEY="$(cat wim-create-key)" wim-relay
#
# WIM_RELAY_URLS must be the exact public URL(s) clients dial (a TLS proxy in front terminates wss).
# Creating a mesh needs WIM_CREATE_KEY (or WIM_OPEN_CREATE=1 to let anyone create one); with
# neither, the relay refuses every create. README.md lists every setting.
FROM node:25-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
# Only the relay's own dependency tree, without install scripts.
RUN npm ci --omit=dev --ignore-scripts --workspace=@worldinmotion/relay-node && npm cache clean --force

FROM node:25-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370
ENV NODE_ENV=production \
    WIM_DB=/data/wim-relay.db \
    WIM_HOST=0.0.0.0 \
    PORT=8787
WORKDIR /app
COPY --from=deps /app /app
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "packages/relay-node/src/bin.ts"]
