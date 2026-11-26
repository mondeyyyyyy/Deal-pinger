# Playwright's image ships Chromium + all system libraries it needs. Version must match package.json.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    DATA_DIR=/data \
    PORT=3000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY scripts ./scripts

EXPOSE 3000
CMD ["node", "--no-warnings", "src/index.js"]
