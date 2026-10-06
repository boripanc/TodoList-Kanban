# Production image: builds the app, then runs the server, which serves both
# the app and its API on one port. Set DATABASE_URL (and COOKIE_SECURE=true
# behind https) where you deploy it.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY --from=build /app/dist ./dist
EXPOSE 8787
CMD ["npm", "start"]
