# Tek imaj: API, işçi ve web aynı kod tabanından çalışır (komut compose'ta değişir).
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY . .
ARG API_URL=http://api:4000
ENV API_URL=${API_URL} NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app /app
RUN useradd -r -u 1001 app && chown -R app /app
USER app
EXPOSE 4000 3000
CMD ["node", "apps/api/dist/main.js"]
