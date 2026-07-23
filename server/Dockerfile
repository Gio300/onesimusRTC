# Server image also carries the static web client (served from ../web).
FROM node:20-alpine
WORKDIR /app
COPY server/package.json ./server/
RUN cd server && npm install --omit=dev
COPY server ./server
COPY web ./web
WORKDIR /app/server
ENV PORT=8080
EXPOSE 8080
CMD ["node", "index.js"]
