# syntax=docker/dockerfile:1.7

FROM oven/bun:1 AS builder
WORKDIR /app

COPY package.json bun.lock* bun.lockb* ./
RUN bun install --frozen-lockfile

COPY . .

ARG VITE_SERVER_URL
ARG VITE_SIM_URL
ARG VITE_SOCKET_URL
ENV VITE_SERVER_URL=${VITE_SERVER_URL}
ENV VITE_SIM_URL=${VITE_SIM_URL}
ENV VITE_SOCKET_URL=${VITE_SOCKET_URL}

RUN bun run build

FROM nginx:alpine AS runner

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
