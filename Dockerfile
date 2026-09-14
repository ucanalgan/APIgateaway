FROM node:20-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/gateway/package.json packages/gateway/package.json
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY packages/core packages/core
COPY packages/gateway packages/gateway
RUN npx tsc --build packages/core packages/gateway \
 && node packages/core/scripts/copy-lua.mjs \
 && node packages/gateway/scripts/copy-assets.mjs

FROM base AS runtime
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/gateway/package.json packages/gateway/package.json
RUN npm ci --omit=dev --workspace=@apigate/core --workspace=@apigate/gateway
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/gateway/dist packages/gateway/dist
COPY gateway.yaml gateway.docker.yaml ./

USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/gateway/dist/index.js"]
