// Copyright IBM Corp. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const grpc = require('@grpc/grpc-js');
const { connect, hash, signers } = require('@hyperledger/fabric-gateway');
const crypto = require('node:crypto');
const fs = require('fs').promises; 
const path = require('node:path');
const { TextDecoder } = require('node:util');
const chokidar = require('chokidar');
const express = require('express');
const app = express();
const PORT = 1980;

const mqtt = require('mqtt');
const client = mqtt.connect('mqtt://172.31.242.103:1883');
const mqttTopic = 'kedip'; // ganti sesuai topik SCADA kamu

// Konfigurasi untuk Org1
const org1Config = {
    mspId: 'Org1MSP',
    cryptoPath: path.resolve(
        __dirname,
        '..',
        '..',
        'fabric-samples',
        'test-network',
        'organizations',
        'peerOrganizations',
        'org1.example.com'
    ),
    keyDirectoryPath: path.resolve(
        __dirname,
        '..',
        '..',
        'fabric-samples',
        'test-network',
        'organizations',
        'peerOrganizations',
        'org1.example.com',
        'users',
        'User1@org1.example.com',
        'msp',
        'keystore'
    ),
    certDirectoryPath: path.resolve(
        __dirname,
        '..',
        '..',
        'fabric-samples',
        'test-network',
        'organizations',
        'peerOrganizations',
        'org1.example.com',
        'users',
        'User1@org1.example.com',
        'msp',
        'signcerts'
    ),
    tlsCertPath: path.resolve(__dirname, '..', '..', 'fabric-samples', 'test-network', 'organizations', 'peerOrganizations', 'org1.example.com', 'peers', 'peer0.org1.example.com', 'tls', 'ca.crt'),
    peerEndpoint: 'peer0.org1.example.com:7051',
    peerHostAlias: 'peer0.org1.example.com'
};

// Konfigurasi untuk Org2
const org2Config = {
    mspId: 'Org2MSP',
    cryptoPath: path.resolve(
        __dirname,
        '..',
        '..',
        'fabric-samples',
        'test-network',
        'organizations',
        'peerOrganizations',
        'org2.example.com'
    ),
    keyDirectoryPath: path.resolve(
        __dirname,
        '..',
        '..',
        'fabric-samples',
        'test-network',
        'organizations',
        'peerOrganizations',
        'org2.example.com',
        'users',
        'User1@org2.example.com',
        'msp',
        'keystore'
    ),
    certDirectoryPath: path.resolve(
        __dirname,
        '..',
        '..',
        'fabric-samples',
        'test-network',
        'organizations',
        'peerOrganizations',
        'org2.example.com',
        'users',
        'User1@org2.example.com',
        'msp',
        'signcerts'
    ),
    tlsCertPath: path.resolve(__dirname, '..', '..', 'fabric-samples', 'test-network', 'organizations', 'peerOrganizations', 'org2.example.com', 'peers', 'peer0.org2.example.com', 'tls', 'ca.crt'),
    peerEndpoint: 'peer0.org2.example.com:9051',
    peerHostAlias: 'peer0.org2.example.com'
};

// Konfigurasi lainnya
const channelName = envOrDefault('CHANNEL_NAME', 'distribusi');
const chaincodeName = envOrDefault('CHAINCODE_NAME', 'basic');
const utf8Decoder = new TextDecoder();
let lastSource = ''; 
let contractPLTS = null;
let contractPLN = null;

async function main() {
    const filePath = './data.json'; // Lokasi file JSON

    // Pastikan file tersedia
    try {
        await fs.access(filePath);
    } catch (err) {
        console.error(`File ${filePath} tidak ditemukan!`);
        return;
    }

    // 🔗 Buat koneksi awal ke Org1 dan Org2 (hanya sekali)
    try {
        console.log('🔌 Menghubungkan ke jaringan blockchain...');
        contractPLTS = await getContractForOrg('PLTS');
        contractPLN = await getContractForOrg('PLN');
        console.log('Koneksi ke PLTS dan PLN berhasil.');
    } catch (error) {
        console.error(' Gagal membuat koneksi awal:', error);
        return;
    }

    // 🔍 Monitor perubahan file JSON
    const watcher = chokidar.watch(filePath, {
        persistent: true,
        ignoreInitial: true
    });

    watcher.on('change', async (changedPath) => {
        console.log(` File ${changedPath} berubah, memeriksa...`);
        try {
            const fileData = await fs.readFile(filePath, 'utf-8');
            const jsonData = JSON.parse(fileData);
            const source = jsonData.source;

            // Ambil contract sesuai source
            let contract;
            if (source === 'PLTS') {
                contract = contractPLTS;
            } else if (source === 'PLN') {
                contract = contractPLN;
            } else {
                console.log('Source tidak valid. Hanya "PLTS" atau "PLN".');
                return;
            }

            console.log(`Mengirim transaksi dari source: ${source}`);

            // ⛳ Pindahkan log sukses ke dalam try di bawah
            try {
                await createAsset(contract, filePath);
                console.log('✅ Transaksi berhasil dikirim.');
            } catch (error) {
                console.error('🛑 Gagal mengirim transaksi:', error.message);
            }

            await getAllAssets(contract);
        } catch (error) {
            console.error('Kesalahan saat memproses perubahan file:', error);
        }
    });

    watcher.on('error', (error) => {
        console.error('Kesalahan pada chokidar:', error);
    });

    console.log(`Pemantauan file ${filePath} dimulai...`);
}

// Optional: Tutup koneksi saat aplikasi dihentikan (Ctrl+C)
process.on('SIGINT', () => {
    console.log('\n Menutup koneksi blockchain...');

    if (contractPLTS?._gateway) {
        contractPLTS._gateway.close();
        contractPLTS._client.close();
    }

    if (contractPLN?._gateway) {
        contractPLN._gateway.close();
        contractPLN._client.close();
    }

    process.exit();
});

// Fungsi untuk membuat koneksi grpc
async function newGrpcConnection(config) {
    const tlsRootCert = await fs.readFile(config.tlsCertPath);
    const tlsCredentials = grpc.credentials.createSsl(tlsRootCert);
    return new grpc.Client(config.peerEndpoint, tlsCredentials, {
        'grpc.ssl_target_name_override': config.peerHostAlias,
    });
}

// Fungsi untuk mendapatkan identitas pengguna
async function newIdentity(config) {
    const certPath = await getFirstDirFileName(config.certDirectoryPath);
    const credentials = await fs.readFile(certPath);
    return { mspId: config.mspId, credentials };
}

// Fungsi untuk mendapatkan file pertama di dalam folder
async function getFirstDirFileName(dirPath) {
    const files = await fs.readdir(dirPath);
    const file = files[0];
    if (!file) {
        throw new Error(`No files in directory: ${dirPath}`);
    }
    return path.join(dirPath, file);
}

// Fungsi untuk mendapatkan signer
async function newSigner(config) {
    const keyPath = await getFirstDirFileName(config.keyDirectoryPath);
    const privateKeyPem = await fs.readFile(keyPath);
    const privateKey = crypto.createPrivateKey(privateKeyPem);
    return signers.newPrivateKeySigner(privateKey);
}

async function getAssetHistory(contract, assetId) {
    console.log(`\n--> Evaluate Transaction: GetHistoryForAsset untuk ID ${assetId}`);

    try {
        const resultBytes = await contract.evaluateTransaction('GetAssetHistory', assetId);
        const resultJson = utf8Decoder.decode(resultBytes);
        const result = JSON.parse(resultJson);

        console.log(`\n*** Riwayat transaksi untuk ${assetId}:`);
        result.forEach((history, index) => {
            console.log(`Versi ${index + 1}:`, history);
        });

        return result;
    } catch (error) {
        console.error(`Gagal mendapatkan history untuk asset ${assetId}:`, error);
    }
}

async function createAsset(contract, filePath) {
    const fileData = await fs.readFile(filePath, 'utf-8');
    const jsonData = JSON.parse(fileData);
    const source = jsonData.source;  // Misalnya, file berisi { "source": "PLTS" }

    // Validasi source
    if (source !== 'PLTS' && source !== 'PLN') {
        console.log('Source tidak valid. Hanya PLTS atau PLN yang diperbolehkan.');
        return;
    }

    // Menghasilkan ID unik untuk asset baru berdasarkan timestamp
    const assetId = `asset${Date.now()}`; // ID yang di-generate menggunakan timestamp saat transaksi

    // Mengambil nilai untuk kapasitas baterai dan daya beban dari file JSON
    const batteryCapacity = jsonData.batteryCapacity;  // Mengambil dari file data.json
    const loadPower = jsonData.loadPower;  // Mengambil dari file data.json
    const consumedPower = jsonData.consumedPower;
    const durationMinutes = jsonData.durationMinutes;
    const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

    // Validasi nilai batteryCapacity dan loadPower (hanya menerima nilai 0-100)
    if (batteryCapacity < 0 || batteryCapacity > 100) {
        console.log('Kapasitas baterai tidak valid. Harus antara 0 dan 100.');
        return;
    }

    if (loadPower < 0 || loadPower > 200) {
        console.log('Daya beban tidak valid. Harus antara 0 dan 100.');
        return;
    }

    console.log(
        `--> Submit Transaction: CreateAsset, membuat asset baru dengan ID ${assetId}, Source, BatteryCapacity, LoadPower, ConsumedPower, dan Timestamp`
    );

    try {
        await new Promise((r) => setTimeout(r, 1000));
        await contract.submitTransaction(
            'CreateAsset',
            assetId,
            source,
            String(batteryCapacity),
            String(loadPower),
            String(consumedPower),
            String(durationMinutes),
            timestamp
        );
        console.log('*** Transaksi berhasil dikomit');
        await getAssetHistory(contract, assetId);

        // Kirim sinyal kedip 3x ke SCADA (lampu ON/OFF)
        for (let i = 0; i < 3; i++) {
            setTimeout(() => {
                client.publish(mqttTopic, '1', () => {
                    console.log(`${i + 1} ON`);
                });
            }, i * 1000);

            setTimeout(() => {
                client.publish(mqttTopic, '0', () => {
                    console.log(`${i + 1} OFF`);
                });
            }, i * 1000 + 500);
        }

   } catch (error) {
        console.error('Terjadi kesalahan saat membuat asset:', error);
        console.error('🛑 [HTTP 500] Gagal mengubah data, karena id asset sudah ada di ledger.');
        console.error(`📛 Komentar error: ${error.message}`);

        // Penting: tambahkan baris ini agar error dilempar ke luar
        throw new Error(`[HTTP 500] Gagal mengubah data, karena id asset sudah ada di ledger.\nKomentar error: ${error.message}`);
    }
}

async function getAllAssets(contract) {
    console.log(
        '\n--> Evaluate Transaction: GetAllAssets, function returns all the current assets on the ledger'
    );

    const resultBytes = await contract.evaluateTransaction('GetAllAssets');

    const resultJson = utf8Decoder.decode(resultBytes);
    const result = JSON.parse(resultJson);
    console.log('*** Result:', result);
}

function displayInputParameters(config) {
    console.log(`channelName:       ${channelName}`);
    console.log(`chaincodeName:     ${chaincodeName}`);
    console.log(`cryptoPath:        ${config.cryptoPath}`);
    console.log(`keyDirectoryPath:  ${config.keyDirectoryPath}`);
    console.log(`certDirectoryPath: ${config.certDirectoryPath}`);
    console.log(`tlsCertPath:       ${config.tlsCertPath}`);
    console.log(`peerEndpoint:      ${config.peerEndpoint}`);
    console.log(`peerHostAlias:     ${config.peerHostAlias}`);
}

// Fungsi untuk mendapatkan nilai dari environment variable atau default jika tidak ada
function envOrDefault(key, defaultValue) {
    return process.env[key] || defaultValue;
}

async function getContractForOrg(orgName) {
  let config;
  if (orgName === 'PLTS') {
    config = org1Config;
  } else if (orgName === 'PLN') {
    config = org2Config;
  } else {
    throw new Error('Org tidak dikenal');
  }

  const client = await newGrpcConnection(config);
  const gateway = connect({
    client,
    identity: await newIdentity(config),
    signer: await newSigner(config),
    hash: hash.sha256,
  });

  const network = gateway.getNetwork(channelName);
  const contract = network.getContract(chaincodeName);

  // Simpan untuk close nanti, atau buat caching jika mau
  contract._gateway = gateway;
  contract._client = client;

  return contract;
}

app.get('/assets/plts', async (req, res) => {
  try {
    const contract = await getContractForOrg('PLTS');
    const resultBytes = await contract.evaluateTransaction('GetAllAssets');
    const resultJson = utf8Decoder.decode(resultBytes);
    const result = JSON.parse(resultJson);

    res.json(result);

    // Tutup koneksi setelah selesai
    contract._gateway.close();
    contract._client.close();
  } catch (error) {
    console.error(error);
    res.status(500).send('Gagal mengambil data PLTS');
  }
});

app.get('/assets/pln', async (req, res) => {
  try {
    const contract = await getContractForOrg('PLN');
    const resultBytes = await contract.evaluateTransaction('GetAllAssets');
    const resultJson = utf8Decoder.decode(resultBytes);
    const result = JSON.parse(resultJson);

    res.json(result);

    // Tutup koneksi setelah selesai
    contract._gateway.close();
    contract._client.close();
  } catch (error) {
    console.error(error);
    res.status(500).send('Gagal mengambil data PLN');
  }
});

// Akses file statis (CSS, JS, gambar, dll)
app.use(express.static(path.join(__dirname, '..', 'public')));

// Redirect / ke /login
app.get('/', (req, res) => {
  res.redirect('/login');
});

// Halaman login
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

// Halaman data setelah login berhasil
app.get('/data', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'data.html'));
});

// Halaman semua data / lanjutan dari data
app.get('/all', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'all.html'));
});

// Jalankan server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server berjalan di http://0.0.0.0:${PORT}`);
});
// Menjalankan aplikasi
main().catch((error) => {
    console.error('******** Gagal menjalankan aplikasi ********', error);
});
