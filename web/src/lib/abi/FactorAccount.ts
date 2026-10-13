// FactorAccount's ABI, written by contracts/export-abi.sh from the compiled contract. Do not edit by hand.
export const factorAccountAbi = [
  {
    "type": "constructor",
    "inputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "receive",
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "addKey",
    "inputs": [
      {
        "name": "k",
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
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "digest",
    "inputs": [
      {
        "name": "calls",
        "type": "tuple[]",
        "internalType": "struct FactorAccount.Call[]",
        "components": [
          {
            "name": "to",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "value",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "data",
            "type": "bytes",
            "internalType": "bytes"
          }
        ]
      },
      {
        "name": "nonce_",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "deadline",
        "type": "uint256",
        "internalType": "uint256"
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
    "name": "execute",
    "inputs": [
      {
        "name": "calls",
        "type": "tuple[]",
        "internalType": "struct FactorAccount.Call[]",
        "components": [
          {
            "name": "to",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "value",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "data",
            "type": "bytes",
            "internalType": "bytes"
          }
        ]
      },
      {
        "name": "deadline",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "signature",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "results",
        "type": "bytes[]",
        "internalType": "bytes[]"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "factory",
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
    "type": "function",
    "name": "initialize",
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
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "isValidSignature",
    "inputs": [
      {
        "name": "hash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "signature",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes4",
        "internalType": "bytes4"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "key",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
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
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "keyCount",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "keyId",
    "inputs": [
      {
        "name": "k",
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
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "nonce",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "removeKey",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "run",
    "inputs": [
      {
        "name": "calls",
        "type": "tuple[]",
        "internalType": "struct FactorAccount.Call[]",
        "components": [
          {
            "name": "to",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "value",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "data",
            "type": "bytes",
            "internalType": "bytes"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "results",
        "type": "bytes[]",
        "internalType": "bytes[]"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "Executed",
    "inputs": [
      {
        "name": "nonce",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "key",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "calls",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "KeyAdded",
    "inputs": [
      {
        "name": "id",
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
    "type": "event",
    "name": "KeyRemoved",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "BadKey",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadSignature",
    "inputs": []
  },
  {
    "type": "error",
    "name": "CallFailed",
    "inputs": [
      {
        "name": "index",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "Expired",
    "inputs": [
      {
        "name": "deadline",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "KeyExists",
    "inputs": []
  },
  {
    "type": "error",
    "name": "LastKey",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NoCalls",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NoSuchKey",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotAKey",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OnlyFactory",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OnlySelf",
    "inputs": []
  }
] as const;
