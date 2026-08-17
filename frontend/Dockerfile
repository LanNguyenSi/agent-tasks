FROM node:22-slim AS base
WORKDIR /app

# Install workspace deps once for all stages
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
# --ignore-scripts: backend's postinstall (prisma generate) fires across all workspaces here, but backend/prisma is not in this build context.
RUN npm ci --ignore-scripts

FROM base AS dev
WORKDIR /app
COPY . .
EXPOSE 3000
CMD ["npm", "run", "dev", "--workspace=frontend"]

FROM base AS build
WORKDIR /app
COPY . .
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN npm run build --workspace=frontend

FROM node:22-slim AS prod
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --omit=dev --workspace=frontend --ignore-scripts

COPY --from=build /app/frontend/.next frontend/.next
COPY --from=build /app/frontend/package.json frontend/package.json
# next.config.mjs is plain ESM (no TypeScript), so next start re-evaluates it
# directly with no transpile step: the runtime image needs no TS toolchain,
# no frontend/src, and no tsconfig.json. This replaces the three hotfix COPY
# lines added in #455 for the 2026-08-17 incident (next.config.ts needed an
# on-the-fly TS transpile to re-evaluate at container start, which needed the
# typescript package, src/lib/csp.ts+theme.ts, and tsconfig.json's @/* path
# alias -- none of which shipped in this stage).
COPY --from=build /app/frontend/next.config.mjs frontend/next.config.mjs
COPY --from=build /app/frontend/api-origin.mjs frontend/api-origin.mjs

EXPOSE 3000
CMD ["npm", "run", "start", "--workspace=frontend"]

