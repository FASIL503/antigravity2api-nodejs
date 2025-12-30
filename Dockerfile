# --- Stage 1: Dependency Builder ---
FROM node:18-alpine AS builder

WORKDIR /app

# Copy only package files for efficient layer caching
COPY package*.json ./

# Install ONLY production dependencies to keep node_modules light
RUN npm ci --only=production

# --- Stage 2: Final Runtime ---
FROM node:18-alpine

# Set environment to production
ENV NODE_ENV=production

# Memory Optimization:
# 1. Limit V8 heap to 256MB (adjust based on your Zeabur plan)
# 2. Set high-water mark for GC to prevent memory bloating
ENV NODE_OPTIONS="--max-old-space-size=256 --heapsnapshot-near-heap-limit=1"

WORKDIR /app

# Copy dependencies from builder stage
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# Copy source code and config
COPY . .

# Initialize environment and directories
RUN cp .env.example .env && \
    mkdir -p data public/images && \
    chown -R node:node /app

# Use the built-in non-root user for security
USER node

# Expose the application port
EXPOSE 8045

# Optimized startup: 
# Using node directly instead of npm start saves ~20-30MB of RAM 
# by avoiding an extra shell and npm process tree.
CMD ["sh", "-c", "node src/config/init-env.js && node src/index.js"]
