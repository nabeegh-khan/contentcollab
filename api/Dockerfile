# Pinned base image so every rebuild uses the same Node version (CON-8)
FROM node:24

# All later commands run inside /app in the container
WORKDIR /app

# Copy only the package files first, so the install layer is cached
# and reused when only the source code changes (L4 p47-48)
COPY package.json package-lock.json ./

# Install exactly what the lock file lists; tsx is needed to run TypeScript
RUN npm ci

# Now copy the TypeScript config and the source code
COPY tsconfig.json ./
COPY src ./src

# Run as the image's built-in non-root user, not root (SEC-6)
USER node

# Document the port the API listens on (matches PORT=3000 in .env)
EXPOSE 3000

# Start the server with the package.json start script (tsx src/server.ts)
CMD ["npm", "start"]