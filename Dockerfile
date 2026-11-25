FROM mcr.microsoft.com/playwright:v1.52.0-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

ENV PORT=3847
ENV HOST=0.0.0.0
ENV DATA_DIR=/app/data

EXPOSE 3847

CMD ["npm", "run", "start:docker"]
