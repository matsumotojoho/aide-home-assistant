# Railway用 Dockerfile (server + web)
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/mac-agent/package.json apps/mac-agent/
RUN npm ci
COPY . .
RUN npm run build -w @aide/web

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
# DATA_DIR=/data にRailway Persistent Volumeをマウントする
EXPOSE 8787
CMD ["npm", "run", "start", "-w", "@aide/server"]
