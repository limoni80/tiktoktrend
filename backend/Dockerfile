# Playwright's official image already contains Chromium and every system
# library it needs, which is what makes this deployable on Railway/Render/Fly.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY scripts ./scripts

EXPOSE 8787

# Fails the container health check if /api/health stops answering JSON.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.mjs"]
