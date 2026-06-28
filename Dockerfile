# Yoyo Collection — production image.
# Debian "slim" (not Alpine) so sharp's prebuilt binaries install cleanly; the
# database uses Node's built-in node:sqlite, so there's nothing native to build.
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

# Install deps first for better layer caching.
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Keep the database and photos on a mounted volume so they survive rebuilds.
ENV DB_PATH=/data/yoyos.db
ENV UPLOAD_DIR=/data/uploads
RUN mkdir -p /data/uploads
VOLUME ["/data"]

EXPOSE 3000
CMD ["node", "server.js"]
