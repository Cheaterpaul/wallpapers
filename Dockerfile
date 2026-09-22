FROM node:26-alpine

ENV NODE_ENV=production \
    PORT=8951

WORKDIR /app
COPY server.mjs index.html ./

USER node
EXPOSE 8951

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/wallpapers" >/dev/null || exit 1

CMD ["node", "server.mjs"]
