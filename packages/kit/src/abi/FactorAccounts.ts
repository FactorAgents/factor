// FactorAccounts's ABI, written by contracts/export-abi.sh from the compiled contract. Do not edit by hand.
export const factorAccountsAbi = [
  {
    "type": "constructor",
    "inputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "addressOf",
    "inputs": [
      {
        "name": "first",
        "type": "tuple",
        "internalType": "struct FactorAccount.Key",
        "components": [
          {
            "name": "kind",
            "type": "uint8",
            "internalType": "enum FactorAccount.Kind"
          },
          {
            "name": "a",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "b",
            "type": "bytes32",
            "internalType": "bytes32"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "create",
    "inputs": [
      {
        "name": "first",
        "type": "tuple",
        "internalType": "struct FactorAccount.Key",
        "components": [
          {
            "name": "kind",
            "type": "uint8",
            "internalType": "enum FactorAccount.Kind"
          },
          {
            "name": "a",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "b",
            "type": "bytes32",
            "internalType": "bytes32"
          }
        ]
      },
      {
        "name": "credential",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "implementation",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "Created",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "keyId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "kind",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum FactorAccount.Kind"
      },
      {
        "name": "a",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "b",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "credential",
        "type": "bytes",
        "indexed": false,
        "internalType": "bytes"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "FailedDeployment",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InsufficientBalance",
    "inputs": [
      {
        "name": "balance",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "needed",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  }
] as const;
