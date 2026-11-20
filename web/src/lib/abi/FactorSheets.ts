// FactorSheets's ABI, written by contracts/export-abi.sh from the compiled contract. Do not edit by hand.
export const factorSheetsAbi = [
  {
    "type": "function",
    "name": "lastHour",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "proves",
    "inputs": [
      {
        "name": "by",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "hour",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "leaf",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "proof",
        "type": "bytes32[]",
        "internalType": "bytes32[]"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "rootOf",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "seal",
    "inputs": [
      {
        "name": "hour",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "root",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "sheets",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "sheetsOf",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "Sealed",
    "inputs": [
      {
        "name": "by",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "hour",
        "type": "uint64",
        "indexed": true,
        "internalType": "uint64"
      },
      {
        "name": "root",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "sheets",
        "type": "uint32",
        "indexed": false,
        "internalType": "uint32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "AlreadySealed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "FutureHour",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NoRoot",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NoSheets",
    "inputs": []
  }
] as const;
