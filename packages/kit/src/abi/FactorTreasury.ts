// FactorTreasury's ABI, written by contracts/export-abi.sh from the compiled contract. Do not edit by hand.
export const factorTreasuryAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "vouch_",
        "type": "address",
        "internalType": "contract FactorVouch"
      },
      {
        "name": "claims_",
        "type": "address",
        "internalType": "contract FactorClaims"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "receive",
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "BPS",
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
    "name": "DAY",
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
    "name": "MAX_CLAIMS",
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
    "name": "MIN_STEP",
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
    "name": "balanceOf",
    "inputs": [
      {
        "name": "agent",
        "type": "address",
        "internalType": "address"
      }
    ],
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
    "name": "claims",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract FactorClaims"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "deposit",
    "inputs": [
      {
        "name": "agent",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "desk",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract FactorDesk"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "gateway",
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
    "name": "guarantee",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract FactorGuarantee"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "held",
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
    "name": "line",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract FactorLine"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "preview",
    "inputs": [
      {
        "name": "agent",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "claimIds",
        "type": "uint256[]",
        "internalType": "uint256[]"
      }
    ],
    "outputs": [
      {
        "name": "repay",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "compute",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "claimPrices",
        "type": "uint256[]",
        "internalType": "uint256[]"
      },
      {
        "name": "toGuarantee",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "toVouch",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "blocked",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "rulesOf",
    "inputs": [
      {
        "name": "agent",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct FactorTreasury.Rules",
        "components": [
          {
            "name": "floor",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "repay",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "repayDaily",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "compute",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "computeDaily",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "claims",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "claimsDaily",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "claimMaxPrice",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "claimMinDiscountBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "claimMinScore",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "claimDeliveredOnly",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "guarantee",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "guaranteeUpTo",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "vouch",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "vouchUpTo",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "run",
    "inputs": [
      {
        "name": "agent",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "claimIds",
        "type": "uint256[]",
        "internalType": "uint256[]"
      }
    ],
    "outputs": [
      {
        "name": "spent",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setRules",
    "inputs": [
      {
        "name": "r",
        "type": "tuple",
        "internalType": "struct FactorTreasury.Rules",
        "components": [
          {
            "name": "floor",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "repay",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "repayDaily",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "compute",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "computeDaily",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "claims",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "claimsDaily",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "claimMaxPrice",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "claimMinDiscountBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "claimMinScore",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "claimDeliveredOnly",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "guarantee",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "guaranteeUpTo",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "vouch",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "vouchUpTo",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "spendable",
    "inputs": [
      {
        "name": "agent",
        "type": "address",
        "internalType": "address"
      }
    ],
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
    "name": "spentToday",
    "inputs": [
      {
        "name": "agent",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "step",
        "type": "uint8",
        "internalType": "enum FactorTreasury.Step"
      }
    ],
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
    "name": "totalsOf",
    "inputs": [
      {
        "name": "agent",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct FactorTreasury.Totals",
        "components": [
          {
            "name": "deposited",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "withdrawn",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "repaid",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "compute",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "claims",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "guarantee",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "vouch",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "runs",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "claimsBought",
            "type": "uint32",
            "internalType": "uint32"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "vouch",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract FactorVouch"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "withdraw",
    "inputs": [
      {
        "name": "to",
        "type": "address",
        "internalType": "address payable"
      },
      {
        "name": "amount",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "ClaimBought",
    "inputs": [
      {
        "name": "agent",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "job",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "price",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "face",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ComputePrepaid",
    "inputs": [
      {
        "name": "agent",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "gateway",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Deposited",
    "inputs": [
      {
        "name": "agent",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "from",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "balance",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "GuaranteeBacked",
    "inputs": [
      {
        "name": "agent",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "deskAddress",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "bond",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "LineRepaid",
    "inputs": [
      {
        "name": "agent",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "account",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "debt",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Ran",
    "inputs": [
      {
        "name": "agent",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "by",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "spent",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "balance",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RulesSet",
    "inputs": [
      {
        "name": "agent",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "rules",
        "type": "tuple",
        "indexed": false,
        "internalType": "struct FactorTreasury.Rules",
        "components": [
          {
            "name": "floor",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "repay",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "repayDaily",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "compute",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "computeDaily",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "claims",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "claimsDaily",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "claimMaxPrice",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "claimMinDiscountBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "claimMinScore",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "claimDeliveredOnly",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "guarantee",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "guaranteeUpTo",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "vouch",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "vouchUpTo",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Skipped",
    "inputs": [
      {
        "name": "agent",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "step",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum FactorTreasury.Step"
      },
      {
        "name": "ref",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "VouchBacked",
    "inputs": [
      {
        "name": "agent",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "deskAddress",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "bond",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Withdrawn",
    "inputs": [
      {
        "name": "agent",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "to",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "balance",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "BadRules",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NothingToDo",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OverBalance",
    "inputs": [
      {
        "name": "balance",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "PushFailed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ReentrancyGuardReentrantCall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "TooMany",
    "inputs": []
  },
  {
    "type": "error",
    "name": "WrongDesk",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroAddress",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroAmount",
    "inputs": []
  }
] as const;
