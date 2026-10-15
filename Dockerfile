# Build stage: install workspaces, build the single-file bundle.
FROM node:22-alpine AS build
WORKDIR /src
COPY . .
RUN npm ci && npm run build --workspace @hps/gateway

# Runtime: one file, no node_modules.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0
COPY --from=build /src/packages/gateway/dist/server.mjs ./server.mjs
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "server.mjs"]
