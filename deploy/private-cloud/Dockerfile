# syntax=docker/dockerfile:1
# Private-cloud container image for lemma Pro tier.
# Built per LEM-135 container conventions (Node 22/bookworm-slim, pnpm workspace build).
# Build from repository root:
#   docker build -f deploy/private-cloud/Dockerfile -t lemma-private-cloud:local .

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    LEMMA_DEPLOYMENT_MODE=private-cloud \
    LEMMA_LICENSE_VALIDATION=enabled \
    LEMMA_TUNNELS_PROXIES=disabled \
    LEMMA_OUTBOUND_ALLOWLIST=""
WORKDIR /app

# Application artifacts (state/evidence/reports must be stored on mounted volumes inside the VPC)
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/pro-services ./pro-services
COPY --from=build /app/schemas ./schemas
COPY --from=build /app/policies ./policies
COPY --from=build /app/deploy/private-cloud ./deploy/private-cloud

VOLUME ["/app/.lemma"]
EXPOSE 3000

# Default entrypoint can be overridden for specific pro services/workflows.
ENTRYPOINT ["node", "packages/cli/dist/cli.js"]
CMD ["--help"]
