FROM node:24-alpine
WORKDIR /app
# зависимостей нет: только встроенные модули Node.js
COPY server.js ./
COPY public ./public
COPY seed ./seed
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data COOKIE_SECURE=1
EXPOSE 3000
CMD ["node", "server.js"]
