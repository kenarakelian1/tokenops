# TokenOps web dashboard — static build + nginx (same-origin /v1 proxy)
# Build context: repository root
#   docker build -f deploy/web.Dockerfile -t tokenops-web .

FROM node:22-bookworm-slim AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# All workspace package.json files for lockfile integrity
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/agent/package.json apps/agent/

# Full install (root + web typescript toolchain; web also declares typescript itself)
RUN pnpm install --frozen-lockfile

COPY apps/web apps/web

# Empty VITE_API_URL → browser uses same origin; nginx proxies /v1 to api
ENV VITE_API_URL=
RUN pnpm --filter @tokenops/web build

FROM nginx:1.27-alpine AS runner
# gettext provides envsubst
RUN apk add --no-cache gettext
COPY deploy/nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
# Compose-friendly default; override on Railway to *.railway.internal
ENV API_UPSTREAM=tokenops-api:3000
EXPOSE 80
CMD ["/bin/sh", "-c", "envsubst '${API_UPSTREAM}' < /etc/nginx/templates/default.conf.template > /etc/nginx/conf.d/default.conf && exec nginx -g 'daemon off;'"]
