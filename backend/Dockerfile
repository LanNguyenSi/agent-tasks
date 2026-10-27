FROM node:22-slim AS base
WORKDIR /app

# Install workspace deps once for all stages
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --ignore-scripts

FROM base AS dev
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
EXPOSE 3001
CMD ["npm", "run", "dev", "--workspace=backend"]

FROM base AS build
# openssl lets Prisma detect the libssl version of this image; without it the
# "native" target resolves to openssl-1.1.x and the prod image (openssl 3) has
# no matching query engine on arm64.
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN npm run db:generate --workspace=backend
RUN npm run build --workspace=backend

FROM node:22-slim AS prod
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --omit=dev --workspace=backend --ignore-scripts

COPY --from=build /app/backend/dist backend/dist
COPY --from=build /app/backend/prisma backend/prisma
COPY --from=build /app/node_modules/.prisma node_modules/.prisma
COPY --from=build /app/node_modules/@prisma node_modules/@prisma

EXPOSE 3001
CMD ["npm", "run", "start", "--workspace=backend"]

