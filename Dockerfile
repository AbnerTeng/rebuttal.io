FROM node:20-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:20-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY public/ ./public/

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/rebuttals.db

EXPOSE 3000

CMD ["node", "dist/server.js"]
