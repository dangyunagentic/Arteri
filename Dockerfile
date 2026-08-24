FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock* ./
COPY server/package.json server/
COPY web/package.json web/
RUN bun install --frozen-lockfile || bun install
COPY web/ web/
RUN bun run --cwd web build

FROM oven/bun:1
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY server/ server/
COPY --from=build /app/web/dist/ web/dist/
EXPOSE 8787
VOLUME ["/app/data"]
CMD ["bun", "run", "server/src/index.ts"]
