# Node 24 LTS (Node 22 left maintenance on 2026-04-30). One image serves web, worker and one-off migrations.
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
# The build needs no runtime secrets: env is validated at startup, not at build time.
RUN pnpm build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
RUN useradd --system --uid 10001 --create-home app && mkdir -p /app/data/media && chown -R app /app/data
USER app
EXPOSE 3000
# Default: the web app. The worker and the one-off migration run the same image with another command (see docker-compose.prod.yml);
# migrations are a deploy step, never part of `next build`.
# The binaries are started directly, not through `pnpm`: pnpm itself is fetched by corepack on first use, which a locked-down production
# container may not be able to do (and must not need to).
CMD ["node_modules/.bin/next", "start"]
