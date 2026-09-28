# Used by Railway (or any Docker host) to run YouTube Studio online.
FROM node:22-slim

# fontconfig lets FFmpeg find the caption font.
RUN apt-get update && apt-get install -y --no-install-recommends fontconfig ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# Listen for visitors from the internet, and keep all data on the mounted disk (/data).
ENV HOST=0.0.0.0 \
    DATA_DIR=/data \
    WORK_DIR=/tmp/studio-work \
    NODE_ENV=production
# Run the server directly (not through npm) so it receives the stop signal from the host.
CMD ["node_modules/.bin/tsx", "server/index.ts", "--prod"]
