FROM node:24 AS build

COPY --from=build /web/dist /usr/share/nginx/html

WORKDIR /web

RUN npm ci

RUN npm run build

FROM nginx

COPY nginx.conf /etc/nginx/nginx.conf

COPY dist/ /usr/share/nginx/html
