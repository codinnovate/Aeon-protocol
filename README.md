# Aeon Protocol — Robinhood Chain sell diagnostics

TypeScript/Node CLI to **diagnose** and (only after explicit confirmation) **sell** an ERC-20 on Robinhood Chain mainnet (chain id `4663`) using **viem**.

## Security

- Private key is read **only** from local `.env` as `PRIVATE_KEY`.
- The key is **never** printed or requested in chat.
- **No transaction is broadcast** during `diagnose` / `quote` / `simulate`.
- `sell` refuses unless simulations pass and you type the exact phrases (`APPROVE` / `SELL …` / `CONFIRM SELL`).
- Default sell size is a **tiny test amount** (`TEST_SELL_AMOUNT`, default `0.001` tokens).

## Setup

```bash
cp .env.example .env
# edit .env — set PRIVATE_KEY locally (never commit)

npm install
```

Read-only without a key (diagnose/quote/simulate only):

```bash
# .env
WALLET_ADDRESS=0xYourPublicAddress
```

## Commands

| Command | Behavior |
|---|---|
| `npm run diagnose` | Token/pool resolution, allowances, contract inspection, transferFrom + swap **simulations** |
| `npm run quote` | Discover Uniswap v2/v3 pools and quote TOKEN→ETH / TOKEN→USDG |
| `npm run simulate` | Full diagnose; non-zero exit if swap sim fails |
| `npm run sell` | Re-runs sims; requires typed confirmations before broadcast |

## Important finding about the token address

The address from the failed transaction:

`0xE1321e41a5A7205a1fa73cd50E2139eAD98ed2EF`

is a **Uniswap V3 pool** (WETH / AEON, 1% fee), not the ERC-20.

The actual token is:

`0x31FFc4beed5A292b9264286118c190174d955212` — **Aeon Swap (AEON)**

The CLI auto-resolves pool → ERC-20 when you pass the pool address.

## Network

- RPC: `https://rpc.mainnet.chain.robinhood.com`
- Explorer: `https://robinhoodchain.blockscout.com`
- Gas token: ETH
- Preferred router: Universal Router **2.1.1** `0x8876789976decbfcbbbe364623c63652db8c0904` (Uniswap docs/SDK)

## Allowances

Two different allowances matter:

1. **ERC20** `token.allowance(wallet, Permit2)`
2. **Permit2** `Permit2.allowance(wallet, token, router)`

Do not confuse them.
