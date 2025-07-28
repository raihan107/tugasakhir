#!/bin/bash

# Fungsi untuk menampilkan pesan jika terjadi error
function error_exit {
  echo "$1" 1>&2
  exit 1
}

# Fungsi untuk memulai jaringan Hyperledger Fabric
function start_network {
  echo "Starting the blockchain network..."
  cd /home/Raihan-tugas-akhir/fabric-samples/test-network || exit
  ./network.sh up -ca || error_exit "Error: Failed to bring up the network."

  echo "Waiting for fabric to be ready..."
  sleep 15

  echo "Creating channel..."
  ./network.sh createChannel || error_exit "Error: Failed to bring up the network."

  echo "Waiting for channel to be ready..."
  sleep 15

  echo "Deploying chaincode..."
  ./network.sh deployCC -ccn basic -ccp ../asset-transfer-basic/chaincode-javascript/ -ccl javascript -c distribusi -ccep "OR('Org1MSP.peer','Org2MSP.peer')" || error_exit "Error: Failed to deploy chaincode."

  echo "Network setup and chaincode deployment completed successfully!"
}

# Fungsi untuk mematikan jaringan Hyperledger Fabric
function stop_network {
  echo "Shutting down the blockchain network..."
  cd /home/Raihan-tugas-akhir/fabric-samples/test-network || exit
  ./network.sh down || error_exit "Error: Failed to shut down the network."

  echo "Network shutdown completed successfully!"
}

# Fungsi untuk menyalin nama file keystore dan menjalankan Docker Compose
function start_explorer {
  # Path direktori organisasi
  ORG1_DIR="/home/Raihan-tugas-akhir/fabric-samples/test-network/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com"
  ORG2_DIR="/home/Raihan-tugas-akhir/fabric-samples/test-network/organizations/peerOrganizations/org2.example.com/users/Admin@org2.example.com"

  # Path ke file JSON di hyperledger-explorer
  EXPLORER_DIR="/home/Raihan-tugas-akhir/hyperledger-explorer"
  PLN_FILE="${EXPLORER_DIR}/plndistribusi-network.json"
  PLTS_FILE="${EXPLORER_DIR}/pltsdistribusi-network.json"

  # Menyalin nama file keystore org1 (untuk PLTS)
  ORG1_KEYSTORE_FILE=$(basename "$(find ${ORG1_DIR}/msp/keystore -type f -name '*_sk')")
  echo "Menambahkan nama file keystore untuk org1 (PLTS): ${ORG1_KEYSTORE_FILE}"

  # Menyalin nama file keystore org2 (untuk PLN)
  ORG2_KEYSTORE_FILE=$(basename "$(find ${ORG2_DIR}/msp/keystore -type f -name '*_sk')")
  echo "Menambahkan nama file keystore untuk org2 (PLN): ${ORG2_KEYSTORE_FILE}"

  # Menambahkan nama file keystore untuk PLN ke dalam file JSON
  jq --arg keystore "/tmp/crypto/peerOrganizations/org2.example.com/users/Admin@org2.example.com/msp/keystore/$ORG2_KEYSTORE_FILE" \
     '.organizations.Org2MSP.adminPrivateKey.path = $keystore' ${PLN_FILE} > ${PLN_FILE}.tmp && mv ${PLN_FILE}.tmp ${PLN_FILE}
  echo "Nama file keystore untuk org2 (PLN) ditambahkan ke ${PLN_FILE}"

  # Menambahkan nama file keystore untuk PLTS ke dalam file JSON
  jq --arg keystore "/tmp/crypto/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp/keystore/$ORG1_KEYSTORE_FILE" \
     '.organizations.Org1MSP.adminPrivateKey.path = $keystore' ${PLTS_FILE} > ${PLTS_FILE}.tmp && mv ${PLTS_FILE}.tmp ${PLTS_FILE}
  echo "Nama file keystore untuk org1 (PLTS) ditambahkan ke ${PLTS_FILE}"

  # Menjalankan docker-compose up
  echo "Menjalankan docker-compose up -d..."
  cd $EXPLORER_DIR || exit
  docker-compose up -d || error_exit "Error: Failed to bring up the explorer network."
  echo "Docker Compose berjalan dengan sukses!"

  # Menjalankan FUXA Docker
  echo "Starting FUXA Docker container..."
  docker start jovial_chaum || error_exit "Error: Failed to start FUXA container."
  echo "FUXA Docker started successfully!"
}

# Fungsi untuk mematikan Docker Compose
function stop_explorer {
  echo "Menjalankan docker-compose down -v..."
  cd /home/Raihan-tugas-akhir/hyperledger-explorer || exit
  docker-compose down -v || error_exit "Error: Failed to shut down the explorer network."
  echo "Docker Compose dimatikan dengan sukses!"

  # Menghentikan FUXA Docker
  echo "Stopping FUXA Docker container..."
  docker stop jovial_chaum || error_exit "Error: Failed to stop FUXA container."
  echo "FUXA Docker stopped successfully!"
}

# Fungsi untuk menjalankan Docker Compose untuk Server
function start_server {
  echo "Menjalankan docker-compose untuk server..."
  cd /home/Raihan-tugas-akhir || exit
  docker-compose up -d || error_exit "Error: Failed to bring up the server Docker Compose."
  echo "Server Docker Compose berjalan dengan sukses!"
}

# Fungsi untuk menghentikan Docker Compose untuk Server
function stop_server {
  echo "Menjalankan docker-compose down untuk server..."
  cd /home/Raihan-tugas-akhir || exit
  docker-compose down || error_exit "Error: Failed to shut down server Docker Compose."
  echo "Server Docker Compose dimatikan dengan sukses!"
}

# Mengecek parameter yang diberikan dan menjalankan fungsi yang sesuai
case "$1" in
  up)
    start_network

    sleep 10
    start_explorer

    sleep 10
    start_server
    ;;
  down)
    stop_server
    stop_explorer
    stop_network
    ;;
  *)
    echo "Usage: $0 {up|down}"
    exit 1
    ;;
esac