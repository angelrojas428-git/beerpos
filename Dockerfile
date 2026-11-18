# syntax=docker/dockerfile:1

# ---- Stage 1: build frontend assets (esbuild + tailwind) ----
FROM node:20-slim AS builder
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm ci
COPY backend/ ./backend/
COPY frontend/ ./frontend/
RUN cd backend && npm run build

# ---- Stage 2: runtime ----
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Install production dependencies (esbuild/tailwind are build-only but harmless at runtime).
COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm ci --omit=dev && npm cache clean --force
# App code + built frontend + db schema.
COPY --from=builder /app/backend/src ./backend/src
COPY --from=builder /app/backend/scripts ./backend/scripts
COPY --from=builder /app/frontend ./frontend
COPY db/ ./db/
# Persistent data (sessions) and uploaded logos.
RUN mkdir -p /app/data /app/backend/uploads
EXPOSE 3001
# Run the server directly (bypasses the `prestart` build hook).
CMD ["node", "backend/src/index.js"]