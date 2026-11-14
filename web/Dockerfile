FROM node:24 AS build

WORKDIR /web

COPY package.json package-lock.json ./

RUN npm ci

COPY . .

RUN npm run build

FROM nginx

COPY --from=build /web/dist /usr/share/nginx/html

COPY nginx.conf /etc/nginx/nginx.conf
