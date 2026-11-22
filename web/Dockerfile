FROM node:24 AS build

WORKDIR /web

COPY package.json package-lock.json ./

RUN npm ci

COPY . .

RUN npm run build

# Runs as uid 101 and listens on 8080 (D27, SEC-6)
FROM nginx/nginx-unprivileged:stable

COPY --from=build /web/dist /usr/share/nginx/html

COPY nginx.conf /etc/nginx/conf.d/default.conf
