# Build context MUST be the monorepo root (not samples/fastify-flyio), because the
# build needs the pnpm workspace (lockfile + packages/core) to resolve
# `@maronn-openid-connect/core: workspace:*`. Build with:
#
#   docker build -f samples/fastify-flyio/Dockerfile .
#
# from the repository root, or via scripts/deploy-fly.sh, which sets this up
# for you. node:sqlite requires Node.js 22.13+; the `node:22-alpine` tag
# tracks the latest 22.x release, which satisfies that floor.

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @maronn-openid-connect/sample-fastify-flyio build

# fastify is a devDependency of the sample (esbuild externalizes it rather
# than bundling it), so the runtime stage installs it fresh from a minimal
# package.json instead of trying to reuse the workspace's node_modules.
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY samples/fastify-flyio/docker/runtime-package.json ./package.json
RUN npm install --omit=dev
COPY --from=build /repo/samples/fastify-flyio/dist/server.js ./dist/server.js
EXPOSE 3010
CMD ["node", "dist/server.js"]
