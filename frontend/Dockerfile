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
COPY --from=build /app/frontend/next.config.ts frontend/next.config.ts
# next start re-evaluates next.config.ts, which imports src/lib/csp (which in
# turn imports src/lib/theme), so the source tree must ship in the runtime image.
COPY --from=build /app/frontend/src frontend/src
# next start also needs the typescript package to transpile next.config.ts.
# It is a devDependency (omitted above), and without it Next falls back to a
# runtime `yarn add typescript` that fails in this image (backend's postinstall
# fires without backend/prisma present), crash-looping the container.
COPY --from=build /app/node_modules/typescript node_modules/typescript

EXPOSE 3000
CMD ["npm", "run", "start", "--workspace=frontend"]

