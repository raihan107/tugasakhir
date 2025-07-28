#include <Wire.h>
#include "INA226.h"
#include <ModbusMaster.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>  

const char* ssid = "";           
const char* password = "";     

const char* mqttServer = ""; // IP Windows
const int mqttPort = 1883;                

// Membuat objek WiFiClient dan PubSubClient
WiFiClient espClient;
PubSubClient client(espClient);

// Inisialisasi INA226 dengan alamat 0x40
INA226 ina(0x40, &Wire);

// Inisialisasi objek ModbusMaster untuk PZEM-004T
ModbusMaster node;

// Tegangan penuh dan tegangan rendah untuk LiFePO4 12V
const float FULL_VOLTAGE = 13.90;  // Tegangan penuh dalam volt (resting)
const float LOW_VOLTAGE = 11.0;   // Tegangan rendah dalam volt (cut-off)
const float VOLTAGE_CALIBRATION_FACTOR = 0.9752;  // Faktor kalibrasi (contoh: 1.03 untuk menaikkan hasil)

// Ubah sesuai GPIO ESP32 yang kamu pakai
#define RXD2 16  // GPIO untuk RX
#define TXD2 17  // GPIO untuk TX
#define blueLedPin 2

// Fungsi untuk reset I2C bus manual (bit-banging)
// Pastikan gunakan pin default SDA=21, SCL=22. Ubah kalau beda.
void resetI2CBus() {
  pinMode(21, OUTPUT);  // SDA
  pinMode(22, OUTPUT);  // SCL

  for (int i = 0; i < 9; i++) {
    digitalWrite(22, LOW);  // Clock low
    delayMicroseconds(5);
    digitalWrite(22, HIGH); // Clock high
    delayMicroseconds(5);
  }

  // STOP condition
  digitalWrite(21, LOW);  // SDA low
  delayMicroseconds(5);
  digitalWrite(22, HIGH); // SCL high
  delayMicroseconds(5);
  digitalWrite(21, HIGH); // SDA high
}

// Inisialisasi INA226 dengan retry jika gagal
bool initINA226WithRetry(int attempts) {
  for (int i = 0; i < attempts; i++) {
    Serial.print("Percobaan deteksi INA226 ke-");
    Serial.println(i + 1);

    if (ina.begin()) {
      Serial.println("INA226 berhasil dideteksi!");
      return true;
    }

    Serial.println("Gagal. Mereset I2C dan mencoba ulang...");
    resetI2CBus();
    Wire.begin();
    delay(500);
  }

  return false;
}

// Scanner I2C untuk bantu debug
void scanI2CDevices() {
  byte error, address;
  int nDevices = 0;

  Serial.println("📡 Memindai perangkat I2C...");
  for (address = 1; address < 127; address++) {
    Wire.beginTransmission(address);
    error = Wire.endTransmission();

    if (error == 0) {
      Serial.print("Perangkat ditemukan di alamat 0x");
      Serial.println(address, HEX);
      nDevices++;
    }
  }

  if (nDevices == 0) {
    Serial.println("Tidak ada perangkat I2C ditemukan!");
  }
}

void setup() {
  Serial.begin(115200);

  pinMode(blueLedPin, OUTPUT);
  digitalWrite(blueLedPin, LOW); // pastikan mati awalnya

  // Menghubungkan ke Wi-Fi
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(1000);
    Serial.println("Menghubungkan ke Wi-Fi...");
  }
  Serial.println("Wi-Fi terhubung!");
  Serial.print("IP Address: ");
  Serial.println(WiFi.localIP());

  blinkBlueLed(2, 300);  // Kedip LED setelah konek

  // MQTT
  client.setServer(mqttServer, mqttPort);

  // Reset I2C manual
  resetI2CBus();
  delay(100);
  Wire.begin();      // SDA/SCL default
  delay(200);        // Delay untuk stabilisasi

  // Deteksi INA226 dengan retry
  bool inaReady = initINA226WithRetry(5); // Ganti bagian ini
  if (!inaReady) {
    Serial.println("INA226 gagal dideteksi setelah 5 percobaan.");
    scanI2CDevices(); // Tambahan untuk bantu debug
    // Jika mau lanjut tanpa INA, lanjutkan saja
    // Jika mau stop program: while (1);
  } else {
    // Kalibrasi hanya jika berhasil deteksi
    ina.setMaxCurrentShunt(20.0, 0.0015);
  }

  // Inisialisasi sensor PZEM-004T
  Serial2.begin(9600, SERIAL_8N1, RXD2, TXD2); // Baudrate + pin
  node.begin(1, Serial2); // ID default PZEM v3.0
  Serial.println("Membaca data daya dari PZEM-004T v3.0");
}

int loopCounter = 0;
int zeroCounter = 0;
float lastSentLoadPower = -1.0; // untuk deteksi perubahan nilai
float lastSentBatteryPercentage = -1.0;

void loop() {
  if (!client.connected()) {
    reconnect();
  }
  client.loop();

  float batteryPercentage = 0.0;
  float loadPower = 0.0;
  float calibratedVoltage = 0.0;
  float rawLoadPower = -1.0;  // akan dipaksa 0 jika gagal baca PZEM
  bool pzemReadSuccess = false;

  // === BACA DATA INA226 (baterai) ===
  if (ina.isConversionReady()) {
    float voltage = ina.getBusVoltage();
    float current = ina.getCurrent();
    float power = ina.getPower();

    calibratedVoltage = voltage * VOLTAGE_CALIBRATION_FACTOR;
    batteryPercentage = calculateBatteryPercentage(calibratedVoltage);
    batteryPercentage = roundTo2Decimal(batteryPercentage);
  }

  // === BACA DATA PZEM004T (load) ===
  uint8_t result = node.readInputRegisters(0x0000, 10);
  if (result == node.ku8MBSuccess) {
    float pzemVoltage = node.getResponseBuffer(0) / 10.0;
    float pzemCurrent = node.getResponseBuffer(1) / 100.0;
    uint32_t power_raw = ((uint32_t)node.getResponseBuffer(4) << 16) | node.getResponseBuffer(3);
    rawLoadPower = power_raw * 0.10;
    rawLoadPower = roundTo2Decimal(rawLoadPower);
    pzemReadSuccess = true;

    Serial.println("==============================");
    Serial.print("Tegangan Baterai     : "); Serial.print(calibratedVoltage); Serial.println(" V");
    Serial.print("Persentase Baterai   : "); Serial.print(batteryPercentage); Serial.println(" %");
    Serial.print("Daya Beban (loadPower): "); Serial.print(rawLoadPower); Serial.println(" W");
    Serial.print("Arus PZEM             : "); Serial.print(pzemCurrent); Serial.println(" A");
    Serial.println("==============================\n");

  } else {
    // GAGAL BACA PZEM
    rawLoadPower = 0.0;  // Perlakukan sebagai 0
    Serial.print("Gagal baca data dari PZEM-004T. Kode error: ");
    Serial.println(result);
    Serial.println("[Simulasi 0] Daya dianggap 0 karena gagal baca.");
  }

  // === FILTER NILAI 0 & PENGIRIMAN ===
  bool loadReadSuccess = false;

  if (rawLoadPower < 1.0) {
    zeroCounter++;
    if (zeroCounter >= 2) {
      loadPower = 0.0;
      loadReadSuccess = true;
      zeroCounter = 0; // reset agar tidak spam 0
      Serial.println("[Valid 0] Dua kali terbaca 0 (termasuk error), kirim 0.");
    } else {
      loadPower = lastSentLoadPower;
      loadReadSuccess = false;
      Serial.println("[Noise 0] Baru sekali terbaca 0 (termasuk error), skip kirim.");
    }
  } else {
    // Nilai normal (> 1.0), selalu kirim
    loadPower = rawLoadPower;
    zeroCounter = 0;
    loadReadSuccess = true;
    Serial.print("[Normal] Kirim daya beban: ");
    Serial.println(loadPower);
  }

  // === KIRIM LOAD POWER JIKA VALID ===
  if (loadReadSuccess) {
    StaticJsonDocument<50> loadDoc;
    char loadBuffer[50];

    if (loadPower > 500.0) {
      Serial.print("[Filter] loadPower terlalu besar (");
      Serial.print(loadPower);
      Serial.println(" W), dikirim sebagai 0.");
      loadPower = 0.0;
    }

    lastSentLoadPower = loadPower;

    loadDoc["load_power"] = loadPower;
    serializeJson(loadDoc, loadBuffer);
    client.publish("data/load_power", loadBuffer);
  }

  // === KIRIM BATTERY PERCENTAGE tiap 2 detik ===
  if (loopCounter % 2 == 0) {
    StaticJsonDocument<50> batteryDoc;
    char batteryBuffer[50];

    if (batteryPercentage <= 0.0) {
      Serial.println("[Battery] Terbaca 0%, kirim data sebelumnya.");
      batteryDoc["battery_percentage"] = (int)lastSentBatteryPercentage;
    } else {
      Serial.print("[Battery] Kirim nilai baru: ");
      Serial.println(batteryPercentage);
      batteryDoc["battery_percentage"] = (int)batteryPercentage;
      lastSentBatteryPercentage = batteryPercentage;
    }

    serializeJson(batteryDoc, batteryBuffer);
    client.publish("data/battery_percentage", batteryBuffer);
  }

  loopCounter++;
  delay(1000);  // delay 1 detik per loop
}

void reconnect() {
  // Coba untuk menghubungkan kembali ke broker MQTT
  while (!client.connected()) {
    Serial.print("Mencoba terhubung ke broker MQTT...");
    if (client.connect("ESP32Client")) {
      Serial.println("Terhubung ke broker MQTT!");
    } else {
      Serial.print("Gagal, mencoba lagi dalam 5 detik...");
      Serial.print("Status koneksi Wi-Fi: ");
      Serial.println(WiFi.status());
      delay(5000);
    }
  }
}
// Fungsi untuk menghitung persentase baterai
float calculateBatteryPercentage(float voltage) {
  if (voltage < LOW_VOLTAGE) return 0;
  if (voltage > FULL_VOLTAGE) return 100;
  return ((voltage - LOW_VOLTAGE) / (FULL_VOLTAGE - LOW_VOLTAGE)) * 100.0;
}

// Membulatkan float ke 2 angka dibelakang koma
float roundTo2Decimal(float val) {
  return round(val * 100.0) / 100.0;
}

// Fungsi tambahan untuk kedip LED biru
void blinkBlueLed(int times, int delayMs) {
  for (int i = 0; i < times; i++) {
    digitalWrite(blueLedPin, HIGH);
    delay(delayMs);
    digitalWrite(blueLedPin, LOW);
    delay(delayMs);
  }
}
