const net = require('net');
const fs = require('fs');
const path = require('path');

// Koneksi TCP ke ESP32
const client = new net.Socket();
const ESP32_IP = process.env.ESP32_IP || '192.168.1.22';   // default jika ENV tidak diset
const ESP32_PORT = process.env.ESP32_PORT || 502;

// Membaca file plc.json
const filePath = '/plc/plc.json';  // Bukan path relatif, tapi shared path

// Variabel untuk menyimpan nilai terakhir yang dikirim
let lastData = {
  switchPLN: null,
  switchPLTS: null
};

client.connect(ESP32_PORT, ESP32_IP, () => {
  console.log('Connected to ESP32');

  // Setiap 1 detik, cek apakah ada perubahan pada data di plc.json
  setInterval(() => {
    fs.readFile(filePath, 'utf8', (err, data) => {
      if (err) {
        console.error('Error reading plc.json file:', err);
        return;
      }

      // Parsing data JSON dari file
      const plcData = JSON.parse(data);

      // Cek apakah ada perubahan pada data
      if (plcData.switchPLN !== lastData.switchPLN || plcData.switchPLTS !== lastData.switchPLTS) {
        // Update nilai terakhir
        lastData.switchPLN = plcData.switchPLN;
        lastData.switchPLTS = plcData.switchPLTS;

        // Kirim data ke ESP32
        sendDataToESP32(plcData.switchPLN, plcData.switchPLTS);
      } else {
        console.log('No changes in data. Not sending.');
      }
    });
  }, 250); // Cek setiap 1 detik
});

// Fungsi untuk mengirim data ke ESP32
function sendDataToESP32(switchPLN, switchPLTS) {
  // Membuat buffer untuk mengirimkan data
  const buffer = Buffer.alloc(4); // 2 byte untuk switchPLN, 2 byte untuk switchPLTS
  buffer.writeUInt16BE(switchPLN, 0); // Menulis switchPLN di byte pertama
  buffer.writeUInt16BE(switchPLTS, 2); // Menulis switchPLTS di byte kedua

  // Kirimkan buffer ke ESP32
  client.write(buffer);
  console.log(`Data sent: switchPLN = ${switchPLN}, switchPLTS = ${switchPLTS}`);
}

// Tangani error atau jika koneksi terputus
client.on('error', (err) => {
  console.log('Connection error:', err.message);
});

client.on('close', () => {
  console.log('Connection closed');
});
