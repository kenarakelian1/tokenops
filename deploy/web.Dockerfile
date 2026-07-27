# TokenOps web dashboard — static build + nginx (same-origin /v1 proxy)
# Build context: repository root
#   docker build -f deploy/web.Dockerfile -t tokenops-web .

FROM node:22-bookworm-slim AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/

RUN pnpm install --frozen-lockfile --filter @tokenops/web...

COPY apps/web apps/web

# Empty VITE_API_URL → browser uses same origin; nginx proxies /v1 to api
ENV VITE_API_URL=
RUN pnpm --filter @tokenops/web build

FROM nginx:1.27-alpine AS runner
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
