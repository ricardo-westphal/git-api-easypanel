FROM node:22-alpine
RUN apk add --no-cache git
WORKDIR /app
COPY server.js /app/server.js
ENV PORT=3000
ENV REPOS_DIR=/data
EXPOSE 3000
CMD ["node", "/app/server.js"]

