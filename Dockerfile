# syntax=docker/dockerfile:1
# Apskaita: Node.js app with OCR (Tesseract lit+eng), PDF tools (poppler), ImageMagick and libxml2 (XSD validation).
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      tesseract-ocr tesseract-ocr-lit tesseract-ocr-eng poppler-utils imagemagick libxml2-utils postgresql-client ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
# Optional: --secret id=ca,src=/path/corporate-ca.pem when building behind a TLS-inspecting proxy.
RUN --mount=type=secret,id=ca,required=false NODE_EXTRA_CA_CERTS=/run/secrets/ca npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY migrations ./migrations
COPY assets ./assets
COPY vendor ./vendor
COPY fixtures ./fixtures
COPY scripts ./scripts
COPY integrations ./integrations
RUN mkdir -p /data/storage && chown -R node:node /data
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3100 STORAGE_DIR=/data/storage
EXPOSE 3100
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.mjs"]
