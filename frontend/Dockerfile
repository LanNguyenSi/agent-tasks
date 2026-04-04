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
RUN npm ci --omit=dev --workspace=frontend

COPY --from=build /app/frontend/.next frontend/.next
COPY --from=build /app/frontend/package.json frontend/package.json
COPY --from=build /app/frontend/next.config.ts frontend/next.config.ts

EXPOSE 3000
CMD ["npm", "run", "start", "--workspace=frontend"]

