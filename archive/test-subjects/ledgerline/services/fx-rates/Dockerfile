# ledgerline/fx-rates -- build context is the ledgerline/ directory:  docker build -f services/fx-rates/Dockerfile .
FROM node:22-alpine
ENV NODE_ENV=production PORT=3105 SERVICE_NAME=fx-rates
WORKDIR /app
COPY package.json package-lock.json ./
# An optional build secret `ca` lets builds behind a TLS-intercepting corporate proxy trust its CA:
#   docker build --secret id=ca,src=/path/to/ca-bundle.crt ...   (ignored when absent)
RUN --mount=type=secret,id=ca,required=false \
    sh -c '[ -f /run/secrets/ca ] && export NODE_EXTRA_CA_CERTS=/run/secrets/ca; npm ci --omit=dev && npm cache clean --force'
COPY lib ./lib
COPY services/fx-rates ./services/fx-rates
USER node
EXPOSE 3105
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 CMD wget -qO- http://127.0.0.1:3105/healthz || exit 1
CMD ["node", "services/fx-rates/index.js"]
