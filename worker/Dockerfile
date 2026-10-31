# Same base and layer order as api/Dockerfile (CON-2, CON-3)
FROM node:24

WORKDIR /app

# Package files first so the install layer is cached across code changes
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

# Non-root (SEC-6)
USER node

# Health endpoint only; the worker takes no application traffic
EXPOSE 3001

CMD ["npm", "start"]
