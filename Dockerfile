# Build stage
FROM node:20-bookworm-slim AS build
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

# Runtime stage
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Install only production deps
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy built app and start script
COPY --from=build /app/dist ./dist
COPY --from=build /app/start.sh ./start.sh

EXPOSE 3000
CMD ["sh", "./start.sh"]
