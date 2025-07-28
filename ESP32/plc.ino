#include <WiFi.h>
#include <ModbusMaster.h>
#include <HardwareSerial.h>

#define WIFI_SSID "Raihan" 
#define WIFI_PASSWORD "77777777"
#define SERVER_PORT 502           // Port Modbus standar

#define MAX485_DE 25  // Pin D4 untuk DE (Driver Enable)
#define MAX485_RE 26  // Pin D2 untuk RE (Receiver Enable)
#define RXD 32
#define TXD 33
#define blueLedPin 2

// Buat objek ModbusMaster
ModbusMaster node;
HardwareSerial MAX485(2);

WiFiServer server(SERVER_PORT);  // Server TCP untuk Modbus

// Fungsi untuk mengatur kontrol arah
void preTransmission() {
  digitalWrite(MAX485_DE, HIGH);  // Aktifkan pengiriman
  digitalWrite(MAX485_RE, LOW);   // Aktifkan mode menerima (RE LOW)
}

void postTransmission() {
  digitalWrite(MAX485_DE, LOW);   // Matikan pengiriman (DE LOW)
  digitalWrite(MAX485_RE, LOW);   // Matikan mode menerima (RE LOW)
}

void setup() {
  Serial.begin(115200);
  
  // Setup WiFi
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(1000);
    Serial.println("Connecting to WiFi...");
  }
  Serial.println("Connected to WiFi");

  // LED biru indikator
  pinMode(blueLedPin, OUTPUT);
  digitalWrite(blueLedPin, LOW);
  blinkBlueLed(2, 300);
  
  // Menampilkan IP ESP32
  Serial.print("ESP32 IP Address: ");
  Serial.println(WiFi.localIP());

  // Mulai server TCP untuk komunikasi dengan server Node.js
  server.begin();

  // Setup Modbus untuk kontrol coil
  MAX485.begin(9600, SERIAL_8N1, RXD, TXD);  
  pinMode(MAX485_DE, OUTPUT);
  pinMode(MAX485_RE, OUTPUT);
  
  digitalWrite(MAX485_DE, LOW);  // (mode menerima) 
  digitalWrite(MAX485_RE, LOW);  // (mode menerima)

  node.begin(2, MAX485);  
  node.preTransmission(preTransmission);
  node.postTransmission(postTransmission);

  Serial.println("Modbus setup complete.");
}

void loop() {
  // Cek apakah ada client yang terhubung untuk komunikasi TCP
  WiFiClient client = server.available();
  if (client) {
    Serial.println("Client connected");

    // Terima data dari client (server Node.js)
    while (client.connected()) {
      if (client.available()) {
        uint8_t data[4]; // Buffer untuk menerima 4 byte data
        int len = client.read(data, sizeof(data)); // Baca data yang diterima

        if (len == 4) {  // Pastikan data yang diterima berjumlah 4 byte
          // Menggabungkan dua byte pertama untuk switchPLN (untuk coil M1)
          uint16_t switchPLN = (data[0] << 8) | data[1];  
          // Menggabungkan dua byte kedua untuk switchPLTS (untuk coil M0)
          uint16_t switchPLTS = (data[2] << 8) | data[3]; 

          // Tampilkan data yang diterima dengan keterangan yang lebih jelas
          Serial.print("Data received: switchPLN = ");
          Serial.println(switchPLN);
          Serial.print("Data received: switchPLTS = ");
          Serial.println(switchPLTS);

          // Kontrol untuk M1 (PLN) - Menggunakan coil 0 (bukan 1)
          if (switchPLN == 1 && switchPLTS == 0) {
            Serial.println("Menyalakan coil M1 (PLN)");
            node.writeSingleCoil(0, false);  // Matikan coil 0 (sebelumnya coil 1) jika hidup
            delay(400);
            node.writeSingleCoil(1, true);   // Nyalakan coil 1 (sebelumnya coil 2)
            delay(70);
          } else if (switchPLN == 0) {
            Serial.println("Mematikan coil M1 (PLN)");
            node.writeSingleCoil(1, false);  // Mematikan coil 1 (sebelumnya coil 2)
            delay(400);
          }

          // Kontrol untuk M2 (PLTS) - Menggunakan coil 1 (bukan 2)
          if (switchPLTS == 1 && switchPLN == 0) {
            Serial.println("Menyalakan coil M2 (PLTS)");
            node.writeSingleCoil(1, false);  // Matikan coil 1 (sebelumnya coil 2) jika hidup
            delay(400);
            node.writeSingleCoil(0, true);   // Nyalakan coil 0 (sebelumnya coil 1)
            delay(70);
          } else if (switchPLTS == 0) {
            Serial.println("Mematikan coil M2 (PLTS)");
            node.writeSingleCoil(0, false);  // Mematikan coil 0 (sebelumnya coil 1)
            delay(400);
          }
        }
      }
    }
    client.stop();
    Serial.println("Client disconnected");
  }
}

void blinkBlueLed(int times, int delayMs) {
  for (int i = 0; i < times; i++) {
    digitalWrite(blueLedPin, HIGH);
    delay(delayMs);
    digitalWrite(blueLedPin, LOW);
    delay(delayMs);
  }
}

