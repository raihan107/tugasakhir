const mqtt = require('mqtt');
const mysql = require('mysql2');
const fs = require('fs');
const path = require('path');

// Koneksi ke broker MQTT
const client = mqtt.connect('mqtt://172.31.242.103:1883');

const mqttSensorClient = mqtt.connect('mqtt://10.145.28.49:1883');

// Koneksi ke database MySQL
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'mysql',
  user: process.env.DB_USER || 'root',             // username MySQL
  password: process.env.DB_PASSWORD || 'distribusi', // password MySQL
  database: process.env.DB_NAME || 'distribusi_db', // nama database
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Cek koneksi pool dengan ambil satu koneksi
pool.getConnection((err, connection) => {
  if (err) {
    console.error('Gagal terkoneksi ke database:', err);
  } else {
    console.log('Terkoneksi ke database MySQL dengan connection pool!');
    connection.release(); // lepas koneksi setelah pengecekan
  }
});

const dataJsonPath = path.resolve(__dirname, '..', 'hyperledger-gateway', 'data.json');

let batteryCapacity = 0;
let loadPower = 0;
let consumedPower = 0;
let switchPLN = 0;
let switchPLTS = 0;
let controlStatus = '0'; 
let lastSource = '';
let accumulatedEnergy = 0;
let source = '';
let isWriting = false;
let consumedPowerCheckpoint = 0;
let batteryReadySince = null;
const delayDuration = 0; 
let isOverload = false;
let lastManualSource = '';
let durationMinutesFloat = 0; 
let lastSourceForDuration = '';
let sessionStartTime = null;
let durationSeconds = 0;
let lastSourceOffTime = null;
let pendingSwitchTo = null;
let lastControlStatus = controlStatus; 




// Fungsi untuk mendapatkan timestamp dengan tanggal, jam, dan detik
function getTimestamp() {
  const now = new Date();
  const day = now.getDate().toString().padStart(2, '0');
  const hours = now.getHours().toString().padStart(2, '0');
  const minutes = now.getMinutes().toString().padStart(2, '0');
  const seconds = now.getSeconds().toString().padStart(2, '0');
  return `${day}:${hours}:${minutes}:${seconds}`;
}

/// Fungsi menyimpan data ke MySQL menggunakan pool
function saveDataToDB(source, batteryCapacity, loadPower, consumedPower) {
  const query = 'INSERT INTO energy_data (batteryCapacity, loadPower, source, consumedPower) VALUES (?, ?, ?, ?)';
  pool.execute(query, [batteryCapacity, loadPower, source, consumedPower], (err, results) => {
    if (err) {
      console.error('Gagal menyimpan data ke MySQL:', err);
    } else {
      console.log('Data berhasil disimpan ke MySQL');
    }
  });
}

function safeWriteJson(filePath, dataObj) {
  const tempPath = filePath + '.tmp';
  try {
    fs.writeFileSync(tempPath, JSON.stringify(dataObj, null, 2), 'utf-8');
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    console.error('Gagal menulis data.json secara aman:', err);
  }
}

function updateDataJson(newData) {
  if (isWriting) {
    console.log('Update data.json sedang berjalan, skip sementara...');
    return;
  }
  isWriting = true;

  const currentSource = newData.source;
  const currentConsumedPower = newData.consumedPower;
  const currentBatteryCapacity = newData.batteryCapacity;
  const currentLoadPower = newData.loadPower;

  // Jika sumber OFF dan sebelumnya ada sumber aktif
  if (switchPLN === 0 && switchPLTS === 0 && lastSource !== '') {
    console.log(`Simpan data ${lastSource} | Durasi: ${durationMinutesFloat.toFixed(1)} menit | Energi: ${accumulatedEnergy.toFixed(2)} Wh`);
    simpanKeJson(lastSource, accumulatedEnergy, durationMinutesFloat, currentBatteryCapacity, currentLoadPower);

    // Reset sesi
    consumedPower = 0;
    lastSource = '';
    accumulatedEnergy = 0;
    durationMinutesFloat = 0;
    consumedPowerCheckpoint = 0;
    lastSourceForDuration = '';
    sessionStartTime = null;
    isWriting = false;
    return;
  }

  // Jika sumber baru aktif atau terjadi perubahan sumber
  if ((lastSource === '' || lastSource !== currentSource) && currentSource !== '') {
    // Jika sebelumnya ada sumber, simpan dulu datanya sebelum pindah
    if (lastSource !== '' && lastSource !== currentSource) {
      console.log(`Sumber berubah dari ${lastSource} ke ${currentSource}, simpan dulu data sebelumnya.`);
      simpanKeJson(lastSource, accumulatedEnergy, durationMinutesFloat, currentBatteryCapacity, currentLoadPower);
    }

    // Reset sesi baru
    lastSource = currentSource;
    consumedPowerCheckpoint = currentConsumedPower;
    accumulatedEnergy = 0;
    durationMinutesFloat = 0;
    lastSourceForDuration = currentSource;
    sessionStartTime = Date.now();
    console.log(`Sumber ${lastSource} ON, mulai hitung durasi dan energi...`);

    isWriting = false;
    return;
  }

  // Jika sumber masih sama, lanjut akumulasi energi
  if (currentSource === lastSource) {
    const delta = currentConsumedPower - consumedPowerCheckpoint;
    if (delta >= 0) {
      accumulatedEnergy += delta;
    }
    consumedPowerCheckpoint = currentConsumedPower;

    isWriting = false;
    return;
  }

  isWriting = false;
}

function simpanKeJson(source, energy, duration, batteryCapacity, loadPower) {
  fs.readFile(dataJsonPath, 'utf-8', (err, data) => {
    let jsonData = {};
    if (!err) {
      try {
        jsonData = JSON.parse(data);
      } catch (e) {
        console.warn('data.json corrupt, overwrite.');
      }
    }

    jsonData.source = source;
    jsonData.durationMinutes = Math.round(duration);
    jsonData.consumedPower = parseFloat(energy.toFixed(2));
    jsonData.batteryCapacity = batteryCapacity;
    jsonData.loadPower = loadPower;

    try {
      safeWriteJson(dataJsonPath, jsonData);
      console.log(`Data sumber ${source} dicatat ke JSON:`, jsonData);
    } catch (writeErr) {
      console.error('Gagal menyimpan data.json:', writeErr);
    }
  });
}

// Fungsi untuk mengirimkan timestamp ke SCADA
function sendTimestamp() {
  const timestamp = getTimestamp();
  if (timestamp) {
    client.publish('timestamp', timestamp);
    console.log(`Mengirim timestamp: ${timestamp}`);
  } else {
    console.log('Timestamp tidak valid.');
  }
}

function serverControl() {
  console.log('Kontrol Server');

  const now = Date.now();

  // Publish data sensor
  client.publish('battery', batteryCapacity.toString());
  client.publish('load', loadPower.toString());
  client.publish('consumedPower', consumedPower.toString());
  client.publish('duration', durationMinutesFloat.toFixed(2).toString());

  // Proteksi: Beban terlalu besar
  if (loadPower > 100) {
    if (!isOverload) {
      isOverload = true;
      switchPLN = 0;
      switchPLTS = 0;
      source = '';
      client.publish('StatusPLN', '0');
      client.publish('StatusPLTS', '0');
      client.publish('statuslampu', '2');
      client.publish('red', '1');
      console.log('Beban berlebih! Semua sumber dimatikan');
      updateDataJson({ source, batteryCapacity, loadPower, consumedPower });
      saveSwitchStatusToPLCJson();
    }
    return;
  } else if (isOverload) {
    isOverload = false;
    console.log('Beban normal kembali. Memulihkan sumber daya...');

    if (batteryCapacity >= 25) {
      source = 'PLTS';
      switchPLTS = 1;
      switchPLN = 0;
      client.publish('StatusPLTS', '1');
      client.publish('StatusPLN', '0');
      client.publish('statuslampu', '1');
    } else {
      source = 'PLN';
      switchPLTS = 0;
      switchPLN = 1;
      client.publish('StatusPLTS', '0');
      client.publish('StatusPLN', '1');
      client.publish('statuslampu', '0');
    }

    client.publish('red', '0');
    updateDataJson({ source, batteryCapacity, loadPower, consumedPower });
    saveSwitchStatusToPLCJson();
  }

  // Pengecekan awal
  if (source === '' && batteryCapacity > 0) {
    if (batteryCapacity >= 25) {
      source = 'PLTS';
      switchPLN = 0;
      switchPLTS = 1;
      console.log('Pengecekan awal: SoC >= 25%, pakai PLTS');
    } else {
      source = 'PLN';
      switchPLN = 1;
      switchPLTS = 0;
      console.log('Pengecekan awal: SoC < 25%, pakai PLN');
    }

    client.publish('StatusPLN', switchPLN.toString());
    client.publish('StatusPLTS', switchPLTS.toString());
    client.publish('statuslampu', switchPLTS === 1 ? '1' : '0');
    client.publish('red', '0');
    updateDataJson({ source, batteryCapacity, loadPower, consumedPower });
    saveSwitchStatusToPLCJson();
    return;
  }

  // Logika hysteresis setelah inisialisasi
  if (source === 'PLN') {
    if (batteryCapacity > 69) {
      if (!batteryReadySince) {
        batteryReadySince = now;
        console.log('SoC');
      } else if (now - batteryReadySince >= delayDuration) {
        // MATIKAN PLN terlebih dahulu
        switchPLN = 0;
        switchPLTS = 0;
        source = '';
        client.publish('StatusPLN', '0');
        client.publish('StatusPLTS', '0');
        client.publish('statuslampu', '2');
        updateDataJson({ source, batteryCapacity, loadPower, consumedPower });
        saveSwitchStatusToPLCJson();

        lastSourceOffTime = now;
        pendingSwitchTo = 'PLTS';
        return;
      } else {
        const sisa = Math.floor((delayDuration - (now - batteryReadySince)) / 500);
        console.log(`Menunggu ${sisa} detik lagi untuk beralih ke PLTS...`);
      }
    } else {
      batteryReadySince = null;
    }
  } else if (source === 'PLTS') {
    if (batteryCapacity < 25) {
      // MATIKAN PLTS terlebih dahulu
      switchPLN = 0;
      switchPLTS = 0;
      source = '';
      client.publish('StatusPLN', '0');
      client.publish('StatusPLTS', '0');
      client.publish('statuslampu', '2');
      updateDataJson({ source, batteryCapacity, loadPower, consumedPower });
      saveSwitchStatusToPLCJson();

      lastSourceOffTime = now;
      pendingSwitchTo = 'PLN';
      batteryReadySince = null;
      return;
    }
  }

  // Eksekusi penundaan aktivasi sumber baru
  if (pendingSwitchTo && lastSourceOffTime && now - lastSourceOffTime >= 1000) {
    if (pendingSwitchTo === 'PLTS') {
      source = 'PLTS';
      switchPLN = 0;
      switchPLTS = 1;
      client.publish('StatusPLTS', '1');
      client.publish('StatusPLN', '0');
      client.publish('statuslampu', '1');
    } else if (pendingSwitchTo === 'PLN') {
      source = 'PLN';
      switchPLN = 1;
      switchPLTS = 0;
      client.publish('StatusPLTS', '0');
      client.publish('StatusPLN', '1');
      client.publish('statuslampu', '0');
    }

    client.publish('red', '0');
    pendingSwitchTo = null;
    lastSourceOffTime = null;
    console.log(`Sumber diaktifkan kembali: ${source}`);
  }

  updateDataJson({ source, batteryCapacity, loadPower, consumedPower });
  saveSwitchStatusToPLCJson();
}

function scadaControl() {
  console.log('Kontrol SCADA');
  const now = Date.now();

  // Publish data sensor
  client.publish('battery', batteryCapacity.toString());
  client.publish('load', loadPower.toString());
  client.publish('consumedPower', consumedPower.toString());
  client.publish('duration', durationMinutesFloat.toFixed(2).toString());

  // Deteksi overload
  if (loadPower > 100) {
    if (!isOverload) {
      isOverload = true;

      // Simpan sumber manual terakhir sebelum dimatikan
      lastManualSource = switchPLTS === 1 ? 'PLTS' : (switchPLN === 1 ? 'PLN' : '');

      switchPLN = 0;
      switchPLTS = 0;
      source = '';
      client.publish('StatusPLN', '0');
      client.publish('StatusPLTS', '0');
      client.publish('statuslampu', '2');
      client.publish('red', '1');

      console.log('Beban berlebih! Semua sumber dimatikan (SCADA)');
      updateDataJson({ source, batteryCapacity, loadPower, consumedPower });
      saveSwitchStatusToPLCJson();
    }
    return;
  }

  // Reset flag overload jika sudah normal
  if (isOverload && loadPower <= 100) {
    isOverload = false;
    console.log('Kondisi kembali normal, flag overload direset');
  }

  // Kirim status normal (bukan overload)
  client.publish('StatusPLN', switchPLN.toString());
  client.publish('StatusPLTS', switchPLTS.toString());

  if (switchPLN === 1) {
    client.publish('statuslampu', '0');
  } else if (switchPLTS === 1) {
    client.publish('statuslampu', '1');
  } else {
    client.publish('statuslampu', '2');
  }

  client.publish('red', '0');

  source = switchPLN === 1 ? 'PLN' : (switchPLTS === 1 ? 'PLTS' : '');
  updateDataJson({ source, batteryCapacity, loadPower, consumedPower });
}

// Koneksi sukses
client.on('connect', () => {
  console.log('Terhubung ke broker MQTT');

  // Mengirimkan kontrol status ke '1' (Server) hanya sekali setelah koneksi berhasil
  client.publish('controlstatus', '1');
  console.log('Control status: 1 dikirim');

  client.publish('kedip', '0', () => {
    console.log('Nilai "0" dikirim ke topik MQTT "kedip"');
  });

  client.subscribe(['controlstatus', 'controlpln', 'controlplts', 'data/battery_percentage', 'data/load_power', 'data/consumedPower'], (err) => {
    if (err) console.log('Gagal berlangganan:', err);
  });

  setInterval(() => {
    if (controlStatus === 0) {
      if (lastControlStatus === 1 && (switchPLTS === 1 || switchPLN === 1)) {
        lastSource = switchPLTS === 1 ? 'PLTS' : 'PLN';
        lastSourceForDuration = lastSource;
        consumedPowerCheckpoint = consumedPower;
        sessionStartTime = Date.now();
        console.log(`Pindah ke SCADA, sinkronisasi lastSource: ${lastSource}`);
      }

      scadaControl();
    } else {
      serverControl();
    }

    lastControlStatus = controlStatus;
    sendTimestamp();
  }, 1000);

  // Perhitungan rutin tiap detik untuk consumedPower
  setInterval(() => {
    if ((switchPLN === 1 || switchPLTS === 1) && loadPower > 0) {
      const deltaEnergy = loadPower / 3600; 
      consumedPower += deltaEnergy;
      consumedPower = parseFloat(consumedPower.toFixed(2));
      console.log(`Consumed Power (interval): ${consumedPower} Wh`);
    }
  }, 1000);

  setInterval(() => {
    if (switchPLN === 1 || switchPLTS === 1) {
      durationSeconds++;
      durationMinutesFloat = parseFloat((durationSeconds / 60).toFixed(2));
    } else {
      // Sumber baru saja OFF: simpan dulu nilai terakhir duration sebelum reset
      if (durationSeconds > 0) {
        console.log(`Sumber OFF, simpan durasi terakhir: ${durationMinutesFloat} menit`);
        updateDataJson({ source: '', batteryCapacity, loadPower, consumedPower, duration: durationMinutesFloat });
        saveSwitchStatusToPLCJson();

        durationSeconds = 0;
        durationMinutesFloat = 0;
      }
    }
  }, 1000);

  setInterval(() => {
    saveDataToDB(source, batteryCapacity, loadPower, consumedPower);
  }, 10000);
});

// Fungsi untuk menyimpan status switch ke plc.json
function saveSwitchStatusToPLCJson() {
  const switchData = {
    switchPLN: switchPLN,
    switchPLTS: switchPLTS
  };

  // Path menuju file plc.json
  const plcJsonPath = '/plc/plc.json';

  // Menyimpan data ke file plc.json
  fs.writeFile(plcJsonPath, JSON.stringify(switchData, null, 2), 'utf-8', (err) => {
    if (err) {
      console.error('Gagal menyimpan data ke plc.json:', err);
    } else {
      console.log('Status switch berhasil disimpan ke plc.json');
    }
  });
}

// Handler Pesan MQTT
client.on('message', (topic, message) => {
  const payload = message.toString();

  if (topic === 'controlstatus') {
    controlStatus = payload === '0' ? 0 : 1;  // 0 = SCADA, 1 = Server
    console.log(`Mode kontrol: ${controlStatus === 0 ? 'SCADA' : 'Server'}`);
  }

  if (topic === 'controlpln') {
    switchPLN = payload === '1' ? 1 : 0;
    console.log(`Switch PLN: ${switchPLN === 1 ? 'ON' : 'OFF'}`);

    // Menyimpan status switch PLN dan PLTS ke plc.json setelah menerima pesan
    saveSwitchStatusToPLCJson();
  }

  if (topic === 'controlplts') {
    switchPLTS = payload === '1' ? 1 : 0;
    console.log(`Switch PLTS: ${switchPLTS === 1 ? 'ON' : 'OFF'}`);

    // Menyimpan status switch PLN dan PLTS ke plc.json setelah menerima pesan
    saveSwitchStatusToPLCJson();
  }

});

// Event: Jika berhasil konek ke broker MQTT
mqttSensorClient.on('connect', () => {
  console.log('Terhubung ke broker MQTT Sensor');

  // Berlangganan pada topik untuk data sensor
  mqttSensorClient.subscribe('data/battery_percentage', (err) => {
    if (err) console.error('Gagal berlangganan data/battery_percentage:', err);
  });
  
  mqttSensorClient.subscribe('data/load_power', (err) => {
    if (err) console.error('Gagal berlangganan data/load_power:', err);
  });

});

// Event: Jika gagal koneksi atau terjadi error
mqttSensorClient.on('error', (err) => {
  console.error('Tidak dapat terhubung ke broker MQTT Sensor. Alasan:', err.message);
});

// Fungsi untuk menangani pesan yang diterima dari topik MQTT
mqttSensorClient.on('message', (topic, message) => {
  const payload = message.toString();

  try {
    const parsedData = JSON.parse(payload);

    // Data Battery
    if (topic === 'data/battery_percentage') {
      if (parsedData.hasOwnProperty('battery_percentage')) {
        batteryCapacity = parseFloat(parsedData.battery_percentage);
        if (!isNaN(batteryCapacity)) {
          console.log(`Battery: ${batteryCapacity}%`);
        }
      }
    }

    if (topic === 'data/load_power') {
    console.log("Raw payload:", message.toString()); // Tampilkan payload asli
    console.log("Parsed:", parsedData); // Tampilkan hasil parsing

    if (parsedData.hasOwnProperty('load_power')) {
      console.log("Tipe load_power:", typeof parsedData.load_power);
      console.log("Value sebelum parsing:", parsedData.load_power);

      loadPower = parseFloat(parsedData.load_power);

      if (!isNaN(loadPower)) {
        console.log(`✅ Load Power diterima dan valid: ${loadPower} W`);
      } else {
        console.warn("⚠️ Gagal parsing load_power jadi angka:", parsedData.load_power);
      }
    }
  }

  } catch (error) {
    console.error('Gagal mem-parsing data JSON:', error);
  }
});
