# Skye AMM — Account Layout & Swap Interface

## Program ID

`GRBvJRRJfV3CzRLocGcr3NTptWQpu1G4nW9Jpff5TFoX`

## Pool PDA

Seeds: `["pool", skye_mint, wsol_mint]`

## Pool Account Layout (316 bytes)

| Offset | Size | Field | Type | Notes |
|--------|------|-------|------|-------|
| 0 | 8 | discriminator | `[u8; 8]` | Anchor: `sha256("account:Pool")[0..8]` |
| 8 | 32 | authority | `Pubkey` | Admin authority |
| 40 | 32 | skye_mint | `Pubkey` | Token-2022 mint (has Transfer Hook) |
| 72 | 32 | wsol_mint | `Pubkey` | Native SOL mint |
| 104 | 32 | skye_reserve | `Pubkey` | Token-2022 ATA holding SKYE |
| 136 | 32 | wsol_reserve | `Pubkey` | SPL Token ATA holding WSOL |
| 168 | 32 | lp_mint | `Pubkey` | LP token mint |
| 200 | 8 | skye_amount | `u64` | Cached SKYE reserve |
| 208 | 8 | wsol_amount | `u64` | Cached WSOL reserve |
| 216 | 2 | fee_bps | `u16` | Swap fee (100 = 1%) |
| 218 | 1 | bump | `u8` | Pool PDA bump |
| 219 | 1 | lp_authority_bump | `u8` | LP authority PDA bump |
| 220 | 32 | team_wallet | `Pubkey` | 50% fee destination (WSOL ATA) |
| 252 | 32 | diamond_vault | `Pubkey` | Dead state (unused) |
| 284 | 32 | strong_vault | `Pubkey` | Dead state (unused) |

## Swap Instruction

**Discriminator:** `sha256("global:swap")[0..8]` = `[248, 198, 158, 145, 225, 117, 135, 200]`

**Data layout:**

| Offset | Size | Field | Type |
|--------|------|-------|------|
| 0 | 8 | discriminator | `[u8; 8]` |
| 8 | 8 | amount_in | `u64` |
| 16 | 8 | min_amount_out | `u64` |
| 24 | 1 | buy | `bool` |

**Core accounts (10):**

| # | Account | Signer | Writable | Description |
|---|---------|--------|----------|-------------|
| 0 | user | yes | yes | Swap initiator, pays fees |
| 1 | pool | no | yes | Pool PDA |
| 2 | skye_mint | no | no | Token-2022 SKYE mint |
| 3 | wsol_mint | no | no | Native WSOL mint |
| 4 | user_skye_account | no | yes | User's SKYE ATA (Token-2022) |
| 5 | user_wsol_account | no | yes | User's WSOL ATA (SPL Token) |
| 6 | skye_reserve | no | yes | Pool's SKYE reserve ATA |
| 7 | wsol_reserve | no | yes | Pool's WSOL reserve ATA |
| 8 | token_2022_program | no | no | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` |
| 9 | token_program | no | no | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` |

**Remaining accounts (Transfer Hook + fee routing):**

| # | Account | Writable | Description |
|---|---------|----------|-------------|
| 10 | extra_account_metas | no | Hook ExtraAccountMetaList PDA |
| 11 | hook_config | no | Hook Config PDA |
| 12 | sender_wallet_record | yes | Sender's WalletRecord PDA |
| 13 | receiver_wallet_record | yes | Receiver's WalletRecord PDA |
| 14 | lb_pair | no | AMM Pool PDA (price source) |
| 15 | skye_ladder_program | no | `4THAwb6WSpDyyqMHnJL2VBjU7TCLfLLGC5jtuCiyX5Rz` |
| 16 | team_wallet | yes | Treasury WSOL ATA (fee dest) |

## Swap Math

Standard constant-product with input-side fee:

```
fee = amount_in * fee_bps / 10000
effective_in = amount_in - fee
amount_out = effective_in * reserve_out / (reserve_in + effective_in)
```

Fee split: 50% to `team_wallet`, 50% stays in pool reserves.

## Transfer Hook

The SKYE mint has a Token-2022 Transfer Hook extension pointing to the
Skye Ladder program (`4THAwb6WSpDyyqMHnJL2VBjU7TCLfLLGC5jtuCiyX5Rz`).

The hook enforces per-position sell restrictions based on price appreciation.
Buys are unrestricted. Sells are gated by a milestone-based unlock schedule.

The ExtraAccountMetaList PDA uses standard `spl-tlv-account-resolution`
seed-based resolution. All extra accounts are deterministically derivable
from the mint, source owner, and destination owner.

## Live Pools

Every token launched through the Skye launchpad gets its own Pool PDA.
Discover all pools with:

```
getProgramAccounts(GRBvJRRJfV3CzRLocGcr3NTptWQpu1G4nW9Jpff5TFoX, {
  filters: [{ dataSize: 316 }]
})
```
