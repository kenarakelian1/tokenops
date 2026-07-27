# TokenOps API — multi-stage build (pnpm workspace)
# Build context: repository root
#   docker build -f deploy/api.Dockerfile -t tokenops-api .

FROM node:22-bookworm-slim AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Workspace manifests (all packages so lockfile + filters resolve cleanly)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/agent/package.json apps/agent/

# Full install so root devDependencies (typescript, @types/node) are available for tsc.
# Filter-only install would omit the workspace root toolchain.
RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY apps/api apps/api

RUN pnpm --filter @tokenops/shared build \
  && pnpm --filter @tokenops/api build

# Production image — runtime deps only
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/agent/package.json apps/agent/

RUN pnpm install --frozen-lockfile --prod --filter @tokenops/api...

COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/apps/api/dist apps/api/dist
COPY apps/api/drizzle apps/api/drizzle

WORKDIR /app/apps/api
EXPOSE 3000

# Migrations run on process start (see apps/api/src/index.ts)
CMD ["node", "dist/index.js"]
