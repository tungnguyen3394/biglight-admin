# 2026-10-06 (audit #7): Node 20 hết hỗ trợ 30/04/2026 → Node 22 LTS.
# npm ci + package-lock.json: bản dựng trên VPS dùng ĐÚNG phiên bản thư viện đã kiểm (trước: npm install, mỗi lần ra một khác).
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
