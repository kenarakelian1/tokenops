# TokenOps web dashboard — static build + nginx (same-origin /v1 proxy)
# Build context: repository root

FROM node:22-bookworm-slim AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/agent/package.json apps/agent/

RUN pnpm install --frozen-lockfile

COPY apps/web apps/web

# Baked into the client bundle at build time — see apps/web/vite.config.ts,
# which now fails the build loudly if this is unset rather than shipping a
# bundle that white-screens on Clerk's MissingPublishableKey at runtime.
ARG VITE_CLERK_PUBLISHABLE_KEY
ENV VITE_CLERK_PUBLISHABLE_KEY=${VITE_CLERK_PUBLISHABLE_KEY}
ENV VITE_API_URL=
RUN pnpm --filter @tokenops/web build

FROM nginx:1.27-alpine AS runner
RUN apk add --no-cache gettext
COPY deploy/nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html

# Compose defaults (private Docker network). Override on Railway to public HTTPS API.
ENV API_PROXY_PASS=http://tokenops-api:3000
ENV API_PROXY_HOST=tokenops-api

# nginx cannot read PORT the way a Node process can, so it is substituted into
# the config at startup. Railway injects its own PORT and probes that port for
# the healthcheck — without this, the probe hits nothing, nginx logs no request
# at all, and the deploy fails even though nginx is serving correctly. The
# default keeps Compose (which sets no PORT) on 80.
ENV PORT=80

EXPOSE 80
CMD ["/bin/sh", "-c", "envsubst '${API_PROXY_PASS} ${API_PROXY_HOST} ${PORT}' < /etc/nginx/templates/default.conf.template > /etc/nginx/conf.d/default.conf && exec nginx -g 'daemon off;'"]
