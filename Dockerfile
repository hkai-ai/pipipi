FROM node:24-bookworm-slim AS production-dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=4300 \
    ASYNC_PROCESS_RUNS_ENABLED=false
WORKDIR /app

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json package-lock.json ./
# Shipped so a release can apply its own schema before the new container serves.
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node .pi/skills/content-optimization ./.pi/skills/content-optimization
COPY --chown=node:node .pi/skills/content-integrity ./.pi/skills/content-integrity
COPY --chown=node:node .pi/skills/minimal-zine-poster-prompt ./.pi/skills/minimal-zine-poster-prompt
COPY --chown=node:node .pi/skills/tait-crt-interface-prompt ./.pi/skills/tait-crt-interface-prompt
COPY --chown=node:node .pi/skills/news-image-narrative-monument-prompt ./.pi/skills/news-image-narrative-monument-prompt
COPY --chown=node:node .pi/skills/news-image-pale-watercolor-prompt ./.pi/skills/news-image-pale-watercolor-prompt
COPY --chown=node:node .pi/skills/news-image-raw-humanism-prompt ./.pi/skills/news-image-raw-humanism-prompt

USER node
EXPOSE 4300

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '4300') + '/healthz').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))"

CMD ["node", "dist/bin/api.js"]
