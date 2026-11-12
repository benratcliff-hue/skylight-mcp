# Ratcliff fork: hosted HTTP entry (src/http.ts). See FORK.md.
FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

FROM node:26-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --from=build /app/dist ./dist
# Skylight's token cache lives on the mounted volume (MCP_DATA_DIR=/data).
EXPOSE 8080
CMD ["node", "dist/http.js"]
