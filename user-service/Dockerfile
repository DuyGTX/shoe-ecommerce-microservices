# 1. Tải môi trường Node.js siêu nhẹ
FROM node:20-alpine

# 2. Tạo thư mục làm việc trong Container
WORKDIR /app

# 3. Copy file danh sách thư viện vào trước
COPY package*.json ./

# 4. Cài đặt các thư viện (npm install)
RUN npm install

# 5. Copy toàn bộ code vào Container
COPY . .

# 6. Lệnh để chạy Service
CMD ["npm", "start"]