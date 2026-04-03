FROM node:22-slim AS base
WORKDIR /app

# Install workspace deps once for all stages
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci

FROM base AS dev
WORKDIR /app
COPY . .
EXPOSE 3001
CMD ["npm", "run", "dev", "--workspace=backend"]

FROM base AS build
WORKDIR /app
COPY . .
RUN npm run db:generate --workspace=backend
RUN npm run build --workspace=backend

FROM node:22-slim AS prod
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --omit=dev --workspace=backend

COPY --from=build /app/backend/dist backend/dist
COPY --from=build /app/backend/prisma backend/prisma
COPY --from=build /app/node_modules/.prisma node_modules/.prisma
COPY --from=build /app/node_modules/@prisma node_modules/@prisma

EXPOSE 3001
CMD ["npm", "run", "start", "--workspace=backend"]

