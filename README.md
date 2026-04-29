# DAC Inception Bot

Automation bot for DAC Quantum Chain Inception testnet.

## Features

- Faucet claim (0.10 tDACC daily)
- Quantum Crates (open 5 per run)
- Burn DACC → Quantum Energy
- Stake DACC (deposit/withdraw/claim)
- Multi-account support (2 accounts)
- Scheduled recurring runs
- Persistent state tracking

## Setup

1. Edit `.env` with your private keys and addresses:

```
ACCOUNT_1_PRIVATE_KEY=0x...
ACCOUNT_1_ADDRESS=0x...(optional — auto-derived from key)
ACCOUNT_2_PRIVATE_KEY=0x...
ACCOUNT_2_ADDRESS=0x...
```

2. Configure run settings:

```
FAUCET_INTERVAL_HOURS=24     # How often to run full cycle
CRATE_OPEN_COUNT=5           # Crates to open per run
BURN_ENABLED=false           # Enable DACC burn
BURN_AMOUNT=0                # Amount to burn
STAKE_ENABLED=false          # Enable staking
STAKE_AMOUNT=0               # Amount to stake
```

## Run

```bash
npm start        # start bot + scheduler
npm run dev      # start with auto-reload
```

## API Endpoints (discovered from inception.dachain.io)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| /api/inception/sync/ | POST | Session sync |
| /api/inception/profile/ | GET | Get user profile |
| /api/inception/faucet/ | POST | Claim faucet |
| /api/inception/faucet/status/{addr}/ | GET | Faucet status |
| /api/inception/crate/open/ | POST | Open Quantum Crates |
| /api/inception/crate/history/ | GET | Crate history |
| /api/inception/exchange/confirm-burn/ | POST | Burn DACC → QE |
| /api/inception/exchange/confirm-stake/ | POST | Stake DACC |
| /api/inception/exchange/history/ | GET | Exchange history |
| /api/inception/claim-badge/ | POST | Claim early badge |
| /api/inception/task/ | GET | Get tasks |
| /api/inception/qe-history/ | GET | Quantum Energy history |
| /api/auth/wallet/ | POST | Wallet sign-in |

## Network

- RPC: `https://rpctest.dachain.tech`
- Explorer: `https://exptest.dachain.tech`
- Chain ID: `0x5586` (21894 decimal)
- Gas: 0.0001 DACC
- Faucet: `https://faucet.dachain.tech` (0.10 tDACC / 24h)
