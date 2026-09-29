FROM node:20-alpine
WORKDIR /app
COPY package.json server.js ./
ENV PORT=7000 DATA_DIR=/data
VOLUME /data
EXPOSE 7000
CMD ["node", "server.js"]
