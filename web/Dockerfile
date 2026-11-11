FROM node:24 AS build

COPY --from=build /web/dist /usr/share/nginx/html

WORKDIR /web

RUN npm ci

RUN npm run build

COPY dist/ /usr/share/nginx/html

EXPOSE 3000
