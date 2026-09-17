# V4 capture experiment: offline comparison

Fixture: E:\lp-monitor\.worktrees\live-runtime-performance\artifacts\performance\v4-capture-fixture.json
Schema: schemaVersion 1, bigint codec "decimal-string"
Range: 600..4800, end 0x00000000000000000000000000000000000000000000000000000000000012c0 at 4860

| measure | pool-ids | manager |
|---|---|---|
| requests | 5 | 5 |
| operation requests | 1 | 1 |
| response bytes | 22195 | 22195 |
| log keys | 18 | 18 |
| pools in batch catalogue | 3 | 3 |
| watched log keys | 18 | 18 |
| unknown log keys | 0 | 0 |
| completeness | complete | complete |
| eligible for live | true | true |

Log key difference:

```json
{
  "onlyInPoolIds": [],
  "onlyInManager": []
}
```

Reasons:

```json
{
  "pool-ids": [],
  "manager": []
}
```

Shards:

```json
{
  "pool-ids": [
    {
      "filterId": "discovery-v3",
      "status": "success",
      "logCount": 0,
      "request": {
        "fromBlock": "600",
        "toBlock": "4800",
        "addresses": 1,
        "topicAlternatives": [
          1,
          2,
          null,
          null
        ]
      }
    },
    {
      "filterId": "discovery-v3",
      "status": "success",
      "logCount": 0,
      "request": {
        "fromBlock": "600",
        "toBlock": "4800",
        "addresses": 1,
        "topicAlternatives": [
          1,
          null,
          2,
          null
        ]
      }
    },
    {
      "filterId": "discovery-v4",
      "status": "success",
      "logCount": 3,
      "request": {
        "fromBlock": "600",
        "toBlock": "4800",
        "addresses": 1,
        "topicAlternatives": [
          1,
          null,
          2,
          null
        ]
      }
    },
    {
      "filterId": "discovery-v4",
      "status": "success",
      "logCount": 1,
      "request": {
        "fromBlock": "600",
        "toBlock": "4800",
        "addresses": 1,
        "topicAlternatives": [
          1,
          null,
          null,
          2
        ]
      }
    },
    {
      "filterId": "operation-v4",
      "status": "success",
      "logCount": 18,
      "request": {
        "fromBlock": "600",
        "toBlock": "4800",
        "addresses": 1,
        "topicAlternatives": [
          5,
          3
        ]
      }
    }
  ],
  "manager": [
    {
      "filterId": "discovery-v3",
      "status": "success",
      "logCount": 0,
      "request": {
        "fromBlock": "600",
        "toBlock": "4800",
        "addresses": 1,
        "topicAlternatives": [
          1,
          2,
          null,
          null
        ]
      }
    },
    {
      "filterId": "discovery-v3",
      "status": "success",
      "logCount": 0,
      "request": {
        "fromBlock": "600",
        "toBlock": "4800",
        "addresses": 1,
        "topicAlternatives": [
          1,
          null,
          2,
          null
        ]
      }
    },
    {
      "filterId": "discovery-v4",
      "status": "success",
      "logCount": 3,
      "request": {
        "fromBlock": "600",
        "toBlock": "4800",
        "addresses": 1,
        "topicAlternatives": [
          1,
          null,
          2,
          null
        ]
      }
    },
    {
      "filterId": "discovery-v4",
      "status": "success",
      "logCount": 1,
      "request": {
        "fromBlock": "600",
        "toBlock": "4800",
        "addresses": 1,
        "topicAlternatives": [
          1,
          null,
          null,
          2
        ]
      }
    },
    {
      "filterId": "operation-v4",
      "status": "success",
      "logCount": 18,
      "request": {
        "fromBlock": "600",
        "toBlock": "4800",
        "addresses": 1,
        "topicAlternatives": [
          5
        ]
      }
    }
  ]
}
```

Decoded events:

```json
{
  "pool-ids": [
    {
      "key": "4663:0x0000000000000000000000000000000000000000000000000000000000000259:0x0000000000000000000000000000000000000000000000000000000000018935:1",
      "kind": "initialize",
      "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xa4507d1b00e137dac0b0b126ac956872ce7af52ee968fc04923ef9847789c400",
      "amountIn": null,
      "amountOut": null,
      "delta": null
    },
    {
      "key": "4663:0x000000000000000000000000000000000000000000000000000000000000025a:0x0000000000000000000000000000000000000000000000000000000000018936:2",
      "kind": "initialize",
      "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xbd5d39caba84e647b6b76116acfe5219f4492de78b7b206685750e042e31cd20",
      "amountIn": null,
      "amountOut": null,
      "delta": null
    },
    {
      "key": "4663:0x000000000000000000000000000000000000000000000000000000000000025b:0x0000000000000000000000000000000000000000000000000000000000018937:3",
      "kind": "initialize",
      "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xca9d56510396ebd9799c3dc57a3c6d5028b6c9c24d07dfd58b74ae3bad730cad",
      "amountIn": null,
      "amountOut": null,
      "delta": null
    },
    {
      "key": "4663:0x0000000000000000000000000000000000000000000000000000000000000295:0x0000000000000000000000000000000000000000000000000000000000018971:1",
      "kind": "swap",
      "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xa4507d1b00e137dac0b0b126ac956872ce7af52ee968fc04923ef9847789c400",
      "amountIn": "2000000000",
      "amountOut": "2000000000",
      "delta": null
    },
    {
      "key": "4663:0x00000000000000000000000000000000000000000000000000000000000003c1:0x0000000000000000000000000000000000000000000000000000000000018a9d:1",
      "kind": "swap",
      "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xbd5d39caba84e647b6b76116acfe5219f4492de78b7b206685750e042e31cd20",
      "amountIn": "2000000000",
      "amountOut": "2000000000",
      "delta": null
    },
    {
      "key": "4663:0x00000000000000000000000000000000000000000000000000000000000004ed:0x0000000000000000000000000000000000000000000000000000000000018bc9:1",
      "kind": "swap",
      "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xca9d56510396ebd9799c3dc57a3c6d5028b6c9c24d07dfd58b74ae3bad730cad",
      "amountIn": "2000000000",
      "amountOut": "2000000000",
      "delta": null
    },
    {
      "key": "4663:0x0000000000000000000000000000000000000000000000000000000000000619:0x0000000000000000000000000000000000000000000000000000000000018cf5:1",
      "kind": "swap",
      "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xa4507d1b00e137dac0b0b126ac956872ce7af52ee968fc04923ef9847789c400",
      "amountIn": "2000000000",
      "amountOut": "2000000000",
      "delta": null
    },
    {
      "key": "4663:0x0000000000000000000000000000000000000000000000000000000000000745:0x0000000000000000000000000000000000000000000000000000000000018e21:1",
      "kind": "swap",
      "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xbd5d39caba84e647b6b76116acfe5219f4492de78b7b206685750e042e31cd20",
      "amountIn": "2000000000",
      "amountOut": "2000000000",
      "delta": null
    },
    {
      "key": "4663:0x0000000000000000000000000000000000000000000000000000000000000871:0x0000000000000000000000000000000000000000000000000000000000018f4d:1",
      "kind": "swap",
      "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xca9d56510396ebd9799c3dc57a3c6d5028b6c9c24d07dfd58b74ae3bad730cad",
      "amountIn": "2000000000",
      "amountOut": "2000000000",
      "delta": null
    },
    {
      "key": "4663:0x000000000000000000000000000000000000000000000000000000000000099d:0x0000000000000000000000000000000000000000000000000000000000019079:1",
      "kind": "swap",
      "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xa4507d1b00e137dac0b0b126ac956872ce7af52ee968fc04923ef9847789c400",
      "amountIn": "2000000000",
      "amountOut": "2000000000",
      "delta": null
    },
    {
      "key": "4663:0x0000000000000000000000000000000000000000000000000000000000000ac9:0x00000000000000000000000000000000000000000000000000000000000191a5:1",
      "kind": "swap",
      "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xbd5d39caba84e647b6b76116acfe5219f4492de78b7b206685750e042e31cd20",
      "amountIn": "2000000000",
      "amountOut": "2000000000",
      "delta": null
    },
    {
      "key": "4663:0x0000000000000000000000000000000000000000000000000000000000000bf5:0x00000000000000000000000000000000000000000000000000000000000192d1:1",
      "kind": "swap",
      "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xca9d56510396ebd9799c3dc57a3c6d5028b6c9c24d07dfd58b74ae3bad730cad",
      "amountIn": "2000000000",
      "amountOut": "2000000000",
      "delta": null
    },
    {
      "key": "4663:0x0000000000000000000000000000000000000000000000000000000000000d21:0x00000000000000000000000000000000000000000000000000000000000193fd:1",
      "kind": "swap",
      "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xa4507d1b00e137dac0b0b126ac956872ce7af52ee968fc04923ef9847789c400",
      "amountIn": "2000000000",
      "amountOut": "2000000000",
      "delta": null
    },
    {
      "key": "4663:0x0000000000000000000000000000000000000000000000000000000000000e4d:0x0000000000000000000000000000000000000000000000000000000000019529:1",
      "kind": "swap",
      "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xbd5d39caba84e647b6b76116acfe5219f4492de78b7b206685750e042e31cd20",
      "amountIn": "2000000000",
      "amountOut": "2000000000",
      "delta": null
    },
    {
      "key": "4663:0x0000000000000000000000000000000000000000000000000000000000000f79:0x0000000000000000000000000000000000000000000000000000000000019655:1",
      "kind": "swap",
      "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xca9d56510396ebd9799c3dc57a3c6d5028b6c9c24d07dfd58b74ae3bad730cad",
      "amountIn": "2000000000",
      "amountOut": "2000000000",
      "delta": null
    },
    {
      "key": "4663:0x00000000000000000000000000000000000000000000000000000000000010a5:0x0000000000000000000000000000000000000000000000000000000000019781:1",
      "kind": "swap",
      "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xa4507d1b00e137dac0b0b126ac956872ce7af52ee968fc04923ef9847789c400",
      "amountIn": "2000000000",
      "amountOut": "2000000000",
      "delta": null
    },
    {
      "key": "4663:0x00000000000000000000000000000000000000000000000000000000000011d1:0x00000000000000000000000000000000000000000000000000000000000198ad:1",
      "kind": "swap",
      "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xbd5d39caba84e647b6b76116acfe5219f4492de78b7b206685750e042e31cd20",
      "amountIn": "2000000000",
      "amountOut": "2000000000",
      "delta": null
    },
    {
      "key": "4663:0x00000000000000000000000000000000000000000000000000000000000012c0:0x000000000000000000000000000000000000000000000000000000000001999c:0",
      "kind": "swap",
      "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xa4507d1b00e137dac0b0b126ac956872ce7af52ee968fc04923ef9847789c400",
      "amountIn": "30000000000",
      "amountOut": "30000000000",
      "delta": null
    }
  ],
  "manager": [
    {
      "key": "4663:0x0000000000000000000000000000000000000000000000000000000000000259:0x0000000000000000000000000000000000000000000000000000000000018935:1",
      "kind": "initialize",
      "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xa4507d1b00e137dac0b0b126ac956872ce7af52ee968fc04923ef9847789c400",
      "amountIn": null,
      "amountOut": null,
      "delta": null
    },
    {
      "key": "4663:0x000000000000000000000000000000000000000000000000000000000000025a:0x0000000000000000000000000000000000000000000000000000000000018936:2",
      "kind": "initialize",
      "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xbd5d39caba84e647b6b76116acfe5219f4492de78b7b206685750e042e31cd20",
      "amountIn": null,
      "amountOut": null,
      "delta": null
    },
    {
      "key": "4663:0x000000000000000000000000000000000000000000000000000000000000025b:0x0000000000000000000000000000000000000000000000000000000000018937:3",
      "kind": "initialize",
      "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xca9d56510396ebd9799c3dc57a3c6d5028b6c9c24d07dfd58b74ae3bad730cad",
      "amountIn": null,
      "amountOut": null,
      "delta": null
    },
    {
      "key": "4663:0x0000000000000000000000000000000000000000000000000000000000000295:0x0000000000000000000000000000000000000000000000000000000000018971:1",
      "kind": "swap",
      "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xa4507d1b00e137dac0b0b126ac956872ce7af52ee968fc04923ef9847789c400",
      "amountIn": "2000000000",
      "amountOut": "2000000000",
      "delta": null
    },
    {
      "key": "4663:0x00000000000000000000000000000000000000000000000000000000000003c1:0x0000000000000000000000000000000000000000000000000000000000018a9d:1",
      "kind": "swap",
      "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xbd5d39caba84e647b6b76116acfe5219f4492de78b7b206685750e042e31cd20",
      "amountIn": "2000000000",
      "amountOut": "2000000000",
      "delta": null
    },
    {
      "key": "4663:0x00000000000000000000000000000000000000000000000000000000000004ed:0x0000000000000000000000000000000000000000000000000000000000018bc9:1",
      "kind": "swap",
      "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xca9d56510396ebd9799c3dc57a3c6d5028b6c9c24d07dfd58b74ae3bad730cad",
      "amountIn": "2000000000",
      "amountOut": "2000000000",
      "delta": null
    },
    {
      "key": "4663:0x0000000000000000000000000000000000000000000000000000000000000619:0x0000000000000000000000000000000000000000000000000000000000018cf5:1",
      "kind": "swap",
      "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xa4507d1b00e137dac0b0b126ac956872ce7af52ee968fc04923ef9847789c400",
      "amountIn": "2000000000",
      "amountOut": "2000000000",
      "delta": null
    },
    {
      "key": "4663:0x0000000000000000000000000000000000000000000000000000000000000745:0x0000000000000000000000000000000000000000000000000000000000018e21:1",
      "kind": "swap",
      "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xbd5d39caba84e647b6b76116acfe5219f4492de78b7b206685750e042e31cd20",
      "amountIn": "2000000000",
      "amountOut": "2000000000",
      "delta": null
    },
    {
      "key": "4663:0x0000000000000000000000000000000000000000000000000000000000000871:0x0000000000000000000000000000000000000000000000000000000000018f4d:1",
      "kind": "swap",
      "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xca9d56510396ebd9799c3dc57a3c6d5028b6c9c24d07dfd58b74ae3bad730cad",
      "amountIn": "2000000000",
      "amountOut": "2000000000",
      "delta": null
    },
    {
      "key": "4663:0x000000000000000000000000000000000000000000000000000000000000099d:0x0000000000000000000000000000000000000000000000000000000000019079:1",
      "kind": "swap",
      "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xa4507d1b00e137dac0b0b126ac956872ce7af52ee968fc04923ef9847789c400",
      "amountIn": "2000000000",
      "amountOut": "2000000000",
      "delta": null
    },
    {
      "key": "4663:0x0000000000000000000000000000000000000000000000000000000000000ac9:0x00000000000000000000000000000000000000000000000000000000000191a5:1",
      "kind": "swap",
      "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xbd5d39caba84e647b6b76116acfe5219f4492de78b7b206685750e042e31cd20",
      "amountIn": "2000000000",
      "amountOut": "2000000000",
      "delta": null
    },
    {
      "key": "4663:0x0000000000000000000000000000000000000000000000000000000000000bf5:0x00000000000000000000000000000000000000000000000000000000000192d1:1",
      "kind": "swap",
      "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xca9d56510396ebd9799c3dc57a3c6d5028b6c9c24d07dfd58b74ae3bad730cad",
      "amountIn": "2000000000",
      "amountOut": "2000000000",
      "delta": null
    },
    {
      "key": "4663:0x0000000000000000000000000000000000000000000000000000000000000d21:0x00000000000000000000000000000000000000000000000000000000000193fd:1",
      "kind": "swap",
      "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xa4507d1b00e137dac0b0b126ac956872ce7af52ee968fc04923ef9847789c400",
      "amountIn": "2000000000",
      "amountOut": "2000000000",
      "delta": null
    },
    {
      "key": "4663:0x0000000000000000000000000000000000000000000000000000000000000e4d:0x0000000000000000000000000000000000000000000000000000000000019529:1",
      "kind": "swap",
      "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xbd5d39caba84e647b6b76116acfe5219f4492de78b7b206685750e042e31cd20",
      "amountIn": "2000000000",
      "amountOut": "2000000000",
      "delta": null
    },
    {
      "key": "4663:0x0000000000000000000000000000000000000000000000000000000000000f79:0x0000000000000000000000000000000000000000000000000000000000019655:1",
      "kind": "swap",
      "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xca9d56510396ebd9799c3dc57a3c6d5028b6c9c24d07dfd58b74ae3bad730cad",
      "amountIn": "2000000000",
      "amountOut": "2000000000",
      "delta": null
    },
    {
      "key": "4663:0x00000000000000000000000000000000000000000000000000000000000010a5:0x0000000000000000000000000000000000000000000000000000000000019781:1",
      "kind": "swap",
      "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xa4507d1b00e137dac0b0b126ac956872ce7af52ee968fc04923ef9847789c400",
      "amountIn": "2000000000",
      "amountOut": "2000000000",
      "delta": null
    },
    {
      "key": "4663:0x00000000000000000000000000000000000000000000000000000000000011d1:0x00000000000000000000000000000000000000000000000000000000000198ad:1",
      "kind": "swap",
      "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xbd5d39caba84e647b6b76116acfe5219f4492de78b7b206685750e042e31cd20",
      "amountIn": "2000000000",
      "amountOut": "2000000000",
      "delta": null
    },
    {
      "key": "4663:0x00000000000000000000000000000000000000000000000000000000000012c0:0x000000000000000000000000000000000000000000000000000000000001999c:0",
      "kind": "swap",
      "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xa4507d1b00e137dac0b0b126ac956872ce7af52ee968fc04923ef9847789c400",
      "amountIn": "30000000000",
      "amountOut": "30000000000",
      "delta": null
    }
  ],
  "equal": true
}
```

Interpretation:

```json
{
  "pool-ids": {
    "measured": true,
    "qualityErrors": 0,
    "coverageIncompleteMinutes": 1,
    "windows": [
      {
        "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xa4507d1b00e137dac0b0b126ac956872ce7af52ee968fc04923ef9847789c400",
        "rolling": {
          "1m": {
            "status": "closed",
            "reasons": [],
            "swapCount": 1,
            "txCount": 1,
            "usdMicros": "30000000000"
          },
          "5m": {
            "status": "closed",
            "reasons": [],
            "swapCount": 1,
            "txCount": 1,
            "usdMicros": "30000000000"
          },
          "15m": {
            "status": "closed",
            "reasons": [],
            "swapCount": 2,
            "txCount": 2,
            "usdMicros": "32000000000"
          },
          "1h": {
            "status": "closed",
            "reasons": [],
            "swapCount": 5,
            "txCount": 5,
            "usdMicros": "38000000000"
          }
        }
      },
      {
        "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xbd5d39caba84e647b6b76116acfe5219f4492de78b7b206685750e042e31cd20",
        "rolling": {
          "1m": {
            "status": "closed",
            "reasons": [],
            "swapCount": 0,
            "txCount": 0,
            "usdMicros": "0"
          },
          "5m": {
            "status": "closed",
            "reasons": [],
            "swapCount": 1,
            "txCount": 1,
            "usdMicros": "2000000000"
          },
          "15m": {
            "status": "closed",
            "reasons": [],
            "swapCount": 1,
            "txCount": 1,
            "usdMicros": "2000000000"
          },
          "1h": {
            "status": "closed",
            "reasons": [],
            "swapCount": 4,
            "txCount": 4,
            "usdMicros": "8000000000"
          }
        }
      },
      {
        "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xca9d56510396ebd9799c3dc57a3c6d5028b6c9c24d07dfd58b74ae3bad730cad",
        "rolling": {
          "1m": {
            "status": "closed",
            "reasons": [],
            "swapCount": 0,
            "txCount": 0,
            "usdMicros": "0"
          },
          "5m": {
            "status": "closed",
            "reasons": [],
            "swapCount": 0,
            "txCount": 0,
            "usdMicros": "0"
          },
          "15m": {
            "status": "closed",
            "reasons": [],
            "swapCount": 1,
            "txCount": 1,
            "usdMicros": null
          },
          "1h": {
            "status": "closed",
            "reasons": [],
            "swapCount": 4,
            "txCount": 4,
            "usdMicros": null
          }
        }
      }
    ],
    "alerts": [
      {
        "kind": "candidate",
        "status": "provisional",
        "revision": 1,
        "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xa4507d1b00e137dac0b0b126ac956872ce7af52ee968fc04923ef9847789c400",
        "reasons": [
          "candidate",
          "warming/absolute-only",
          "rolling-1m"
        ]
      }
    ]
  },
  "manager": {
    "measured": true,
    "qualityErrors": 0,
    "coverageIncompleteMinutes": 1,
    "windows": [
      {
        "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xa4507d1b00e137dac0b0b126ac956872ce7af52ee968fc04923ef9847789c400",
        "rolling": {
          "1m": {
            "status": "closed",
            "reasons": [],
            "swapCount": 1,
            "txCount": 1,
            "usdMicros": "30000000000"
          },
          "5m": {
            "status": "closed",
            "reasons": [],
            "swapCount": 1,
            "txCount": 1,
            "usdMicros": "30000000000"
          },
          "15m": {
            "status": "closed",
            "reasons": [],
            "swapCount": 2,
            "txCount": 2,
            "usdMicros": "32000000000"
          },
          "1h": {
            "status": "closed",
            "reasons": [],
            "swapCount": 5,
            "txCount": 5,
            "usdMicros": "38000000000"
          }
        }
      },
      {
        "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xbd5d39caba84e647b6b76116acfe5219f4492de78b7b206685750e042e31cd20",
        "rolling": {
          "1m": {
            "status": "closed",
            "reasons": [],
            "swapCount": 0,
            "txCount": 0,
            "usdMicros": "0"
          },
          "5m": {
            "status": "closed",
            "reasons": [],
            "swapCount": 1,
            "txCount": 1,
            "usdMicros": "2000000000"
          },
          "15m": {
            "status": "closed",
            "reasons": [],
            "swapCount": 1,
            "txCount": 1,
            "usdMicros": "2000000000"
          },
          "1h": {
            "status": "closed",
            "reasons": [],
            "swapCount": 4,
            "txCount": 4,
            "usdMicros": "8000000000"
          }
        }
      },
      {
        "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xca9d56510396ebd9799c3dc57a3c6d5028b6c9c24d07dfd58b74ae3bad730cad",
        "rolling": {
          "1m": {
            "status": "closed",
            "reasons": [],
            "swapCount": 0,
            "txCount": 0,
            "usdMicros": "0"
          },
          "5m": {
            "status": "closed",
            "reasons": [],
            "swapCount": 0,
            "txCount": 0,
            "usdMicros": "0"
          },
          "15m": {
            "status": "closed",
            "reasons": [],
            "swapCount": 1,
            "txCount": 1,
            "usdMicros": null
          },
          "1h": {
            "status": "closed",
            "reasons": [],
            "swapCount": 4,
            "txCount": 4,
            "usdMicros": null
          }
        }
      }
    ],
    "alerts": [
      {
        "kind": "candidate",
        "status": "provisional",
        "revision": 1,
        "poolId": "4663:v4:0x0000000000000000000000000000000000000002:0xa4507d1b00e137dac0b0b126ac956872ce7af52ee968fc04923ef9847789c400",
        "reasons": [
          "candidate",
          "warming/absolute-only",
          "rolling-1m"
        ]
      }
    ]
  },
  "equal": true
}
```

Notes:

- Offline replay over a frozen fixture chain. No provider was contacted and no endpoint was configured.
- Request counts and response bytes are planning and payload facts measured on this fixture; they are not provider latency, and this report never converts one into the other.
- An incomplete capture is reported as incomplete and is not interpreted: a range that is not complete cannot become coverage.
- Unknown log keys are manager-universe evidence the catalogue cannot explain. They keep eligibleForLive false and are never removed from the batch.
