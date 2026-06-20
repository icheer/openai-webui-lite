FROM node:22-alpine
WORKDIR /app
COPY worker.js ./
COPY src/server.mjs ./src/
EXPOSE 8787
CMD ["node", "src/server.mjs"]
