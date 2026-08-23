# Mochi voice review - MCP server + Realtime broker.
#
# Multi-arch: NAS boxes are usually arm64, so build with
#   docker buildx build --platform linux/amd64,linux/arm64 .
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/voice-agent/package.json packages/voice-agent/
RUN npm install --no-audit --no-fund

COPY packages ./packages
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
COPY packages/core/package.json packages/core/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/voice-agent/package.json packages/voice-agent/
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/mcp-server/dist packages/mcp-server/dist
COPY --from=build /app/packages/voice-agent/dist packages/voice-agent/dist

# The review ledger lives here; mount it so a container restart does not
# lose the record of what was answered.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
ENV REVIEW_LOG_PATH=/data/reviews.jsonl

USER node
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8765)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/mcp-server/dist/bin.js"]
