# Imagen para publicar la web (Railway, Render, Fly.io o cualquier servidor con Docker).
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev
ENV NODE_ENV=production
ENV PORT=3000
# La base de datos vive en /data: monta ahí un volumen persistente.
ENV DB_FILE=/data/vacaciones.db
EXPOSE 3000
CMD ["node", "--no-warnings", "server/index.js"]
