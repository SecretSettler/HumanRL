FROM node:24.18.1-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7 AS build

# Both build tools ship telemetry enabled by default. `pnpm build` is
# `turbo run build`, so the build stage would report to Vercel without this.
ENV COREPACK_HOME=/opt/corepack \
    NEXT_TELEMETRY_DISABLED=1 \
    TURBO_TELEMETRY_DISABLED=1

WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate

COPY . .
# The Tauri shell is a macOS launcher; its bundle resource is gitignored and
# excluded by .dockerignore, so building it here always fails.
RUN pnpm install --frozen-lockfile --prod=false \
 && pnpm build --filter '!@intenttrace/desktop'

# --legacy is required: from pnpm 10 onward, deploy refuses a workspace without
# inject-workspace-packages=true (ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE).
RUN pnpm deploy --legacy --prod --filter @intenttrace/db /out/migrate \
 && pnpm deploy --legacy --prod --filter @intenttrace/api /out/api \
 && pnpm deploy --legacy --prod --filter @intenttrace/worker /out/worker

FROM node:24.18.1-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    TURBO_TELEMETRY_DISABLED=1

WORKDIR /workspace

COPY --from=build --chown=node:node /out/migrate ./packages/db
COPY --from=build --chown=node:node /out/api ./apps/api
COPY --from=build --chown=node:node /out/worker ./apps/worker
COPY --from=build --chown=node:node /workspace/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /workspace/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /workspace/apps/web/public ./apps/web/public

RUN mkdir -p /var/lib/intenttrace/artifacts && chown -R node:node /var/lib/intenttrace

USER node
