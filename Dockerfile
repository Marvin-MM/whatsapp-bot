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
# Default: the web app. The worker runs the same image with `pnpm worker`;
# migrations run as a separate deploy step: `pnpm db:migrate` (never during `next build`).
CMD ["pnpm", "start"]
