FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV NODE_ENV=production PORT=8787 DATA_DIR=/app/data PHOTO_DIR=/app/photos
EXPOSE 8787
CMD ["npm", "start"]
