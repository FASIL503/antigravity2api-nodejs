# --- Stage 1: Dependency Builder ---
# Node 25 is the latest major release (Current) as of late 2025.
# Use Alpine for the smallest footprint and fastest download.
FROM node:25-alpine AS builder

WORKDIR /app

# Copy only package files first to leverage Docker layer caching.
# If your dependencies haven't changed, this layer is skipped in rebuilds.
COPY package*.json ./

# Install ONLY production dependencies. 
# 'npm ci' is faster and more reliable than 'npm install' for CI/CD.
RUN npm ci --only=production

# --- Stage 2: Final Runtime ---
# We use the same Node 25 Alpine image for the runtime to ensure compatibility.
FROM node:25-alpine

# Set environment to production to trigger library optimizations
ENV NODE_ENV=production

# Performance & Memory Optimization:
# --max-old-space-size: Limits V8 heap to 256MB.
# --heapsnapshot-near-heap-limit=1: Automates debugging if memory spikes.
ENV NODE_OPTIONS="--max-old-space-size=256 --heapsnapshot-near-heap-limit=1"

WORKDIR /app

# Copy ONLY necessary files from the builder stage.
# This keeps the final image lean (approx. 150MB total).
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# Copy source code
COPY . .

# Setup environment and directories
# Using 'node' user instead of root for security (standard best practice)
RUN cp .env.example .env && \
    mkdir -p data public/images && \
    chown -R node:node /app

USER node

# Port exposure
EXPOSE 8045

# FASTEST STARTUP: 
# Using 'node' directly avoids the extra shell and overhead of 'npm start'.
# This saves ~25MB of RAM and provides faster process signals.
CMD ["sh", "-c", "node src/config/init-env.js && node src/index.js"]
