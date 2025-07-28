# Gunakan image node.js yang sesuai sebagai base image
FROM node:16

# Set working directory di dalam container
WORKDIR /app

# Copy file package.json dan package-lock.json ke container
COPY package*.json ./

# Install dependensi yang dibutuhkan
RUN npm install

# Copy seluruh isi folder scadaserver ke dalam container
COPY . .

# Expose port MQTT (jika ingin expose ke luar)
EXPOSE 1883

# Perintah untuk menjalankan server.js
CMD ["node", "server.js"]
