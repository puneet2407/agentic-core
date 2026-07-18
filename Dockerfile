# ---- build stage ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm run build

# ---- runtime stage ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY public ./public

# Durable state (runs, memory, audit) — mount a volume here.
ENV DATA_DIR=/data
VOLUME ["/data"]

# Run as non-root.
RUN addgroup -S app && adduser -S app -G app && mkdir -p /data && chown app:app /data
USER app

EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3100/health || exit 1
CMD ["node", "dist/server.js"]
