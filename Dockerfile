# syntax=docker/dockerfile:1

# ── Build the client (production build → same-origin, no server URL baked in) ──
FROM node:20-alpine AS client
WORKDIR /build/client
COPY client/package.json ./
RUN npm install --no-audit --no-fund
COPY client/ ./
RUN npm run build

# ── Install server production dependencies only ──
FROM node:20-alpine AS server-deps
WORKDIR /build/server
COPY server/package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# ── Final runtime image: Node serves the API, sockets, and the built client ──
FROM node:20-alpine
ENV NODE_ENV=production
ENV SERVE_CLIENT=true
ENV CLIENT_DIST=/app/client/dist
WORKDIR /app
COPY --from=server-deps /build/server/node_modules ./server/node_modules
COPY server/ ./server/
COPY --from=client /build/client/dist ./client/dist
EXPOSE 4000
WORKDIR /app/server
CMD ["node", "src/index.js"]
