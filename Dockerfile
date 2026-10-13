# ---- build: compile TypeScript ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- runtime: production dependencies + compiled JS only ----
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 4007
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT:-4007}/health/live" >/dev/null || exit 1
CMD ["node", "dist/server.js"]
