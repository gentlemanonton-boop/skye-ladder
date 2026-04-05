# Skye Ladder

Structured sell-restriction protocol on Solana. Token-2022 Transfer Hook enforces per-wallet, milestone-based sell limits that scale with price appreciation. Buys are always unrestricted. Only sells are gated.

**Frontend:** [frontend-three-virid-62.vercel.app](https://frontend-three-virid-62.vercel.app)

## How It Works

Every buy creates an independent position with an entry price. The transfer hook calculates a multiplier (current price / entry price) and unlocks selling in phases:

| Phase | Multiplier | Sellable % | Rule |
|---|---|---|---|
| Underwater | ≤ 1x | 100% | Always exit at or below entry. No one is ever trapped. |
| Phase 1 | 1x – 2x | ~100% → ~50% | Sell back your initial SOL investment. Natural taper. |
| Phase 2 | 2x – 5x | 50% → ~56.25% | Compressed growth (half rate). Cliff jump to 62.5% at 5x. |
| Phase 3 | 5x – 10x | 62.5% → ~68.75% | Compressed growth (half rate). Cliff jump to 75% at 10x. |
| Phase 4 | 10x – 15x | 75% → ~87.5% | Compressed growth (half rate). Cliff jump to 100% at 15x. |
| Phase 5 | 15x+ | 100% | Fully unlocked. No restrictions. |

Sell limits are calculated from the **original** position balance, not the remaining balance. Repeated small sells cannot drain a position beyond its unlock percentage.

## Architecture

```
programs/
  skye-ladder/     Anchor program — Token-2022 Transfer Hook
  skye-amm/        Anchor program — Constant-product AMM (x·y=k)
frontend/          React + Vite trading UI (deployed to Vercel)
scripts/           Deployment and testing scripts
```

### Skye Ladder (Transfer Hook)
- Classifies every SKYE transfer as buy, sell, or wallet-to-wallet
- Buys create positions with entry price and initial SOL value
- Sells enforce unlock restrictions per position
- High-water mark: unlock % never decreases
- Sells deduct from highest-multiplier positions first

### Skye AMM (Custom DEX)
- Built because no existing DEX (Meteora, Raydium, Orca) supports permissionless Token-2022 TransferHook pools
- Constant-product formula with 1% fee
- Flushes post-swap reserves to account data before CPI so the hook reads the correct entry price
- Supports Token-2022 transfers with proper hook account forwarding via raw `invoke`

## Contract Addresses (Mainnet)

| Contract | Address |
|---|---|
| **Skye Ladder** (hook) | `4THAwb6WSpDyyqMHnJL2VBjU7TCLfLLGC5jtuCiyX5Rz` |
| **Skye AMM** (pool) | `GRBvJRRJfV3CzRLocGcr3NTptWQpu1G4nW9Jpff5TFoX` |
| **SKYE Mint** | `4w1DQR7HuVNdK6YDKvgyGSQ7A6Ba7ChWL4Hof1HKw1j` |
| **AMM Pool PDA** | `EEqfFMjKAFRMZbRe8hrHngsy3Hm6N7UsKVef1ASCXm3B` |

## Token Details

- **Supply:** 1,000,000,000 SKYE (fixed, no mint authority)
- **Decimals:** 9
- **Standard:** Token-2022 with TransferHook extension
- **Metadata:** Metaplex, image on Arweave

## Build

```bash
# Programs
anchor build

# Frontend
cd frontend && npm install && npm run dev
```

## Tech Stack

- Solana, Anchor 0.30.1, Token-2022
- React, Vite, Tailwind CSS
- CoinGecko API (SOL/USD price for display)
- Arweave (token metadata storage)
- Vercel (frontend hosting)

## Tests

111 unit tests + 10,000+ fuzz scenarios covering unlock calculations, position management, sell enforcement, and the repeated-sell bypass fix.

```bash
cargo test --manifest-path programs/skye-ladder/Cargo.toml
```

## License

MIT
