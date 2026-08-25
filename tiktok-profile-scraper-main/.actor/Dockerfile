FROM apify/actor-node:20

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm ci --include=dev

COPY tsconfig.json ./
COPY src ./src

RUN npm run build && npm prune --omit=dev --no-package-lock

CMD ["node", "dist/main.js"]
