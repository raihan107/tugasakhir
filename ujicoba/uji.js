const mqtt = require('mqtt');

// Konfigurasi koneksi MQTT
const mqttServer = 'mqtt://10.145.28.49';
const mqttPort = 1883;
const client = mqtt.connect(`${mqttServer}:${mqttPort}`);

// Variabel baterai dan siklus
let battery = 25;
let charging = true;

// Variabel load dinamis
let load = 40.5;
let loadNaik = true; // naik ke 98.5, lalu turun ke 40.5

function publishData() {
  const batteryData = { battery_percentage: battery };
  const loadData = { load_power: parseFloat(load.toFixed(1)) };

  client.publish('data/battery_percentage', JSON.stringify(batteryData));
  client.publish('data/load_power', JSON.stringify(loadData));
  console.log(`Dikirim battery: ${battery}% | load: ${load.toFixed(1)}W`);
}

function updateData() {
  // Update baterai
  if (charging) {
    battery++;
    if (battery >= 99) {
      charging = false;
    }
  } else {
    battery--;
    if (battery <= 10) {
      charging = true;
    }
  }

  // Update load
  if (loadNaik) {
    load += 1.0;
    if (load >= 98.5) {
      loadNaik = false;
    }
  } else {
    load -= 1.0;
    if (load <= 40.5) {
      loadNaik = true;
    }
  }
}

client.on('connect', () => {
  console.log("Terhubung ke broker MQTT.");

  setInterval(() => {
    updateData();
    publishData();
  }, 2000);
});

client.on('error', (err) => {
  console.error("Gagal terhubung:", err);
});
