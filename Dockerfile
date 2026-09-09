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
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/gateway/package.json packages/gateway/package.json
RUN npm ci --omit=dev --workspace=@apigate/core --workspace=@apigate/gateway
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/gateway/dist packages/gateway/dist
COPY gateway.yaml ./

EXPOSE 8080
CMD ["node", "packages/gateway/dist/index.js"]
