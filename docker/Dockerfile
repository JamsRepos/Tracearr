# Build stage
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@10.24.0 --activate

WORKDIR /app

# Copy package files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build all packages
RUN pnpm build

# Production stage
FROM node:22-alpine AS runner

RUN corepack enable && corepack prepare pnpm@10.24.0 --activate

WORKDIR /app

ENV NODE_ENV=production

# Copy package files for production install
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/pnpm-lock.yaml ./

# Server package
COPY --from=builder /app/apps/server/package.json ./apps/server/
COPY --from=builder /app/apps/server/dist ./apps/server/dist

# Web static files (served by server or reverse proxy)
COPY --from=builder /app/apps/web/dist ./apps/web/dist

# Shared package
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist

# Database migrations
COPY --from=builder /app/apps/server/src/db/migrations ./apps/server/src/db/migrations

# GeoIP database (if exists in build context)
COPY data/GeoLite2-City.mmdb ./data/GeoLite2-City.mmdb

# Install production dependencies only
RUN pnpm install --prod --frozen-lockfile

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 tracearr

# Set ownership
RUN chown -R tracearr:nodejs /app

USER tracearr

EXPOSE 3000

# Health check - use 127.0.0.1 to force IPv4 (Alpine wget defaults to IPv6 first)
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/health || exit 1

CMD ["node", "apps/server/dist/index.js"]
