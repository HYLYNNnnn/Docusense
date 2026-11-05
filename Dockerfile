FROM node:24-bookworm-slim AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY public ./public
COPY src ./src
RUN CI=true npm run build

FROM node:24-bookworm-slim AS server-dependencies
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=5001
WORKDIR /app/server
COPY --from=server-dependencies --chown=node:node /app/server/node_modules ./node_modules
COPY --chown=node:node server/*.js server/*.mjs server/package.json ./
COPY --from=frontend --chown=node:node /app/build /app/build
USER node
EXPOSE 5001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:5001/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
