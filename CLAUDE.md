# Skye Ladder

A Solana memecoin launchpad with a structured sell-restriction transfer hook,
a custom bonding curve, a custom AMM, and a fully automated graduation
pipeline. Functionally a pump.fun clone with one extra constraint: every
launched token enforces per-position sell limits that scale with price
appreciation, on-chain, via a Token-2022 transfer hook. Buys are unrestricted.
Only sells are gated.

The goal: break the volume-churn cycle where flippers accumulate supply at
low MC and sell into buy volume at 2-4x, creating an artificial ceiling that
kills most tokens below $300K MC.

---

## Three programs, one launchpad

| Program | Crate | Purpose | Mainnet ID |
|---|---|---|---|
| **Skye Ladder** | `programs/skye-ladder` | Token-2022 transfer hook that enforces per-position sell restrictions | `4THAwb6WSpDyyqMHnJL2VBjU7TCLfLLGC5jtuCiyX5Rz` |
| **Skye Curve** | `programs/skye-curve` | Bonding curve launchpad. Mints supply, accumulates buys, fires `graduate` at 85 SOL | `5bxtpbYgiMQMJcB1c2cWXGErsiRmAZeyRqRKCXoeZRXf` |
| **Skye AMM** | `programs/skye-amm` | Constant-product AMM that tokens trade on after graduation | `GRBvJRRJfV3CzRLocGcr3NTptWQpu1G4nW9Jpff5TFoX` |

The user-facing token is **SKYE** (`5GtUWP1x4LpKjAzGBZg9sy9TbTqjY2bvJfgfC7aUmAfF`),
which is the first token launched through the launchpad. SKYE is the launchpad
operator's own coin and earns the team treasury fees from every other launch.

Treasury wallet: `5j5J5sMhwURJv1bdufDUypt29FeRnfv8GLpv53Cy1oxs`
Treasury WSOL ATA (where curve fees + AMM team fees land): `9XxMHTDuE58ESijXdbxRcNwawnyuw9fv8FAj7bV4sdtd`

---

## End-to-end token lifecycle

```
1. User clicks "Launch" in LaunchTab.tsx
   ↓
2. TX 1: Skye Curve launches the token
        - Creates Token-2022 mint with TransferHook extension
        - Initializes Skye Ladder hook config + extra-account-metas PDA
        - Creates curve PDA
        - Mints full 1B supply directly into the curve's token reserve
        - Creates the curve's wallet record
   ↓
3. TX 2: Skye AMM auto-prestages the canonical pool for THIS mint
        - Creates fresh LP mint (lp_authority PDA = mint authority)
        - Creates SKYE & WSOL reserve ATAs owned by Pool PDA
        - Calls AMM initialize_pool(fee_bps=100)
        - Calls AMM set_fee_config(team_wallet=treasury_wsol_ata)
        - Creates incinerator's LP token ATA (rugproof burn destination)
   ↓
4. TX 3: Metaplex metadata upload to Arweave (image + JSON)
   ↓
5. TX 4 (optional): Initial buy if the launcher specified one
   ↓
6. Token trades on the bonding curve. Each trade triggers the transfer hook,
   which enforces sell restrictions per the Skye Ladder rules below.
   ↓
7. Curve.real_sol_reserve eventually crosses 85 SOL.
   ↓
8. The graduation watcher (running 24/7 on Railway) detects the threshold
   and fires curve `graduate` within ~10 seconds.
   ↓
9. graduate atomically:
        - Transfers all remaining tokens curve → AMM pool reserve
        - Transfers all real SOL curve → AMM pool reserve
        - CPIs into AMM seed_pool_from_curve which:
            * Updates pool.skye_amount and pool.wsol_amount
            * Computes initial_lp = sqrt(skye * wsol)
            * Mints all LP tokens to the Solana incinerator
              (1nc1nerator11111111111111111111111111111111)
              → liquidity is permanently locked, rugproof
        - Marks curve.graduated = true
   ↓
10. Token now trades on the AMM. Treasury earns 50% of every swap fee
    forever; the other 50% stays in the pool LP (which is locked).
```

This entire flow is **permissionless and zero-ops**: anyone can launch a
token, and any user (or the relayer) can fire `graduate` once threshold
is crossed. No human in the loop after the launch transaction lands.

---

## Skye Ladder transfer hook — sell restriction rules

The hook enforces a milestone-based unlock schedule with **compressed growth
between milestones**. Each buy creates an independent position with its own
entry price and unlock progress.

### Phase 1: 1x → 2x (Get Your Money Back)
- Sell back the position's initial SOL value at any time
- Live formula: `sellable = initial_sol / (token_balance × current_price)`
- Anyone at or below entry price can ALWAYS sell 100%
- **CRITICAL — `b4c761d` Phase 1 high-water exception**: in Phase 1 the
  formula is `1/mult` which DECREASES as price rises. Writing this to the
  high-water mark would let users sell cheap during Phase 1 and then
  extract more SOL than their initial when price recovers. **Phase 1
  returns the live value but does NOT mutate `unlocked_bps`.**
  Phase 2+ formulas are monotonically increasing in mult, so the
  high-water mark resumes its normal job there.

### Phase 2: 2x → 5x (Compressed Growth)
- 50% at 2x → ~56.25% at 4.99x
- Compressed: `sellable = 0.50 + ((mult - 2) / 3 × 0.125 × 0.5)`
- Cliff jump to 62.5% at exactly 5x

### Phase 3: 5x → 10x
- 62.5% → ~68.75%
- `sellable = 0.625 + ((mult - 5) / 5 × 0.125 × 0.5)`
- Cliff jump to 75% at exactly 10x

### Phase 4: 10x → 15x
- 75% → ~87.5%
- `sellable = 0.75 + ((mult - 10) / 5 × 0.25 × 0.5)`
- Cliff jump to 100% at exactly 15x

### Phase 5: 15x+
- 100% unlocked, no restrictions

### Critical invariants

1. **Each buy is an independent position.** Later buys cannot unlock earlier positions.
2. **All % calculations use current `token_balance`**, not original buy amount.
3. **High-water mark never DECREASES** (the stored `unlocked_bps` value), but Phase 1 doesn't WRITE it.
4. **Sells deduct from highest multiplier first** — sort positions by mult descending, then iterate.
5. **Underwater = 100% sellable.** No one is ever trapped.
6. **Wallet → Wallet transfers = sell + new position.** Sender enforces unlock; receiver gets a new position at current spot price.
7. **Price is SPOT, not TWAP.** Read directly from the curve PDA (or AMM pool, post-graduation). No oracle.
8. **Pool address is whitelisted.** Source = `config.pool` is treated as a buy; destination = `config.pool` is treated as a sell.

---

## State layouts

### `Position` (per-buy record inside a `WalletRecord`)
```rust
pub struct Position {
    pub entry_price:    u64,   // price × 10^18, fixed-point
    pub initial_sol:    u64,   // SOL value at buy time, lamports
    pub token_balance:  u64,   // current raw token amount in this position
    pub unlocked_bps:   u32,   // high-water mark of unlocked %, 0-10000 bps
    pub original_balance: u64, // token amount at buy time, never decremented
    pub sold_before_5x: bool,  // DEAD STATE — claim_rewards was scrapped
    pub claimed:        bool,  // DEAD STATE — claim_rewards was scrapped
}
```

The `sold_before_5x` and `claimed` fields are **kept on disk for layout
compatibility** with live mainnet WalletRecords (41+ of them at time of
writing). Removing them would shift bytes on every existing record and
break deserialization. They're harmless dead bytes; `positions::on_sell`
still writes `sold_before_5x` so the layout stays consistent across
upgrades.

### `WalletRecord`
```rust
pub struct WalletRecord {
    pub owner:          Pubkey,
    pub mint:           Pubkey,
    pub position_count: u8,
    pub positions:      Vec<Position>, // max 10
    pub last_buy_slot:  u64,           // legacy, unused
    pub slot_buy_usd:   u64,           // legacy, unused
    pub bump:           u8,
}
```

PDA seeds: `[b"wallet", owner_pubkey, mint_pubkey]`

The `last_buy_slot` and `slot_buy_usd` fields are leftovers from a removed
per-block bundle protection feature. Same layout-compat reason as above —
left in place but not read.

### Position merging
- **Proximity merge:** new buy within 10% of an existing position's `entry_price` → merge (weighted average entry, sum cost, keep higher unlocked_bps).
- **Hard cap:** max 10 positions per wallet. If exceeded, `merge_closest_pair` combines the two with the closest entry prices.
- **Phase 5 consolidate:** at sell time, all positions at 15x+ get combined into one (they're all 100% unlocked anyway).
- **`merge_closest_pair` bug fixed in this codebase:** the previous version summed two stale `original_balance` values, which produced merged records that could trip the (now-removed) corruption sanitizer. Now uses `merged_token_count` directly and scales `initial_sol` proportionally to un-sold fractions via the `scaled_initial_sol` helper.

---

## Fee model

### Curve (every trade pre-graduation)
- **1.000%** total fee
- 50% → treasury WSOL ATA
- 50% → stays inside curve reserves (compounds, becomes part of the migration liquidity at graduation)

### AMM (every trade post-graduation)
- **1.000%** total fee
- 50% → `team_wallet` (= treasury WSOL ATA, configured during prestage)
- 50% → stays inside the pool reserves (deepens locked LP over time)

### Comparison to pump.fun

| | pump.fun (curve) | Skye (curve) |
|---|---|---|
| Total | 1.250% | 1.000% |
| Creator royalty | 0.300% | **0%** (Skye doesn't pay launchers) |
| Protocol/Treasury | 0.950% | 0.500% |
| LP / reserves | 0% | 0.500% |

| | pump.fun PumpSwap (low MC) | Skye AMM |
|---|---|---|
| Total | 1.250% (drops to 0.375% at 88K SOL MC) | 1.000% flat |
| Creator | 0.300% (drops with MC) | **0%** |
| Protocol | 0.930% (drops to 0.05%) | 0.500% |
| LP | 0.020% (rises to 0.20%) | 0.500% |

**Key differences:** pump pays a creator royalty, Skye doesn't. Pump's
total fee drops as MC grows, Skye's stays flat. Skye's locked LP grows
faster because of the higher pool retention rate. Skye's treasury earns
roughly half what pump's would on early-stage tokens.

---

## Currently live on mainnet

| Component | Slot | Notes |
|---|---|---|
| Skye Ladder program | `411800947` | Includes seed validation, sanitizer fix, merge fix, claim_rewards stub, b4c761d Phase 1 fix, set_test_price gated out |
| Skye Curve program | `411878323` | Auto-flip lockout fixed, atomic graduate via AMM CPI |
| Skye AMM program | `411878108` | `seed_pool_from_curve` instruction live, 50/50 fee split |
| SKYE Pool PDA | `Fp4spHfUgR7RUDhbhdVG8fta2DhURxDyUJoSd2Y2PFcY` | Pre-staged via `scripts/prestage-skye-pool.ts` |
| SKYE LP mint | `7xC9WcW6HAbr8dmSxXHmh5tMLhmrD5gACzHL1QbUKdox` | Supply currently 0; bonded supply gets minted to incinerator |
| Incinerator LP ATA | `ELESgf9X5wnuiejUvZ6MaGworLCapfdqtzQMnQGrQ6HY` | Where the locked LP lands at graduation |
| Helius RPC | Developer tier | Locked to `skyefall.gg` + `www.skyefall.gg` referrers; key rotated to `8ed7e5b2-...` |
| Frontend | https://www.skyefall.gg | Vercel auto-deploys on `main` push; project ID `prj_BsfjlhexfjcoC4A6jWqcwBhCVPo2` |
| Graduation relayer | Railway, $5/mo | Polls every 10s, fires `graduate` on any curve at threshold |
| Relayer hot wallet | `7aCb7JDkS5pcbDicnF1PwqBaACi93zHzg8UE6iM39k4M` | Funded with 0.05 SOL, only pays tx fees |

---

## Repo layout

```
/programs
  /skye-ladder       # transfer hook program
  /skye-curve        # bonding curve program
  /skye-amm          # AMM program
/scripts
  graduate-watcher.ts        # Universal relayer (Railway target)
  prestage-skye-pool.ts      # One-time pool bootstrap (was used for SKYE)
  scan-wallet-records.ts     # Read-only WalletRecord scanner
  _check-fees.ts             # Fee destination audit
  _get-price.ts              # Spot price reader
  test-*.ts                  # Various end-to-end test scripts
  ... etc.
/frontend                    # Vite + React app, deployed to Vercel
  /src/components            # All tabs (Discover, World, Launch, Trade, etc.)
  /src/lib                   # Helpers (metadata, format, unlock, launchStore, etc.)
  SECURITY-NOTES.md          # npm audit accepted-risk documentation
Dockerfile                   # Railway target for the relayer
.dockerignore                # Excludes everything except watcher + deps
.vercelignore                # Excludes test-ledger / Rust stuff from Vercel
```

---

## Operational notes

- **Upgrade authority is permanent.** Per project policy, the program upgrade authority will NOT be frozen. It's treated as a permanent trust assumption — fixes can ship post-launch. Defense is via tight admin gating on instructions, the `set_test_price` feature gate, the `claim_rewards` permanent disable stub, etc.
- **The graduation relayer is permissionless and runs 24/7.** Any bot, any user, or the website itself can fire `graduate`. The Railway watcher just races to be first.
- **Local dev uses public RPC, not Helius**, because the locked-down Helius key rejects requests from `localhost` referrers. `frontend/.env.local` is set to `https://solana-rpc.publicnode.com`. Vercel production has its own `VITE_RPC_URL` env var with the locked Helius key.
- **The 5 corrupt wallet records.** A scan in `scans/scan-2026-04-07-with-price.json` identified 5 live SKYE WalletRecords with garbled state from layout migration. They're handled safely by the impossible-balance filter in `transfer_hook::load_wallet_record_mut`. A targeted `reset_wallet_record` admin instruction is on the backlog but not yet built.
- **Pre-existing test failures.** `cargo test -p skye-ladder --lib` shows 7 failing tests in `tests::comprehensive::test_5*` (the `pool_price` tests). These are stale test fixtures, not real bugs; the `pool_price.rs` reader requires non-empty pool data and the tests pass empty data. Cosmetic, on the backlog.

---

## Build & deploy

```bash
# Build all programs (BPF target — needs Solana toolchain on PATH)
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
anchor build --no-idl
# IDL build is broken on Anchor 0.30.1 + recent proc-macro2 versions
# (anchor-syn calls Span::source_file which was removed). --no-idl
# avoids this.

# Test individual programs
cargo test -p skye-ladder --lib
cargo test -p skye-curve  --lib
cargo test -p skye-amm    --lib

# Upgrade a program on mainnet (only the upgrade authority can sign this)
anchor upgrade target/deploy/skye_ladder.so \
  --program-id 4THAwb6WSpDyyqMHnJL2VBjU7TCLfLLGC5jtuCiyX5Rz \
  --provider.cluster mainnet

# Run the relayer locally (for testing — production runs on Railway)
npx ts-node scripts/graduate-watcher.ts --once
npx ts-node scripts/graduate-watcher.ts --interval 10
```

---

## Math conventions

- All on-chain math is fixed-point. **No `f64` ever.**
- Prices: `u64` scaled by `10^18` (`PRICE_SCALE`)
- SOL amounts: lamports (raw `u64`)
- Token amounts: raw `u64` (no decimal scaling beyond the mint's own decimals)
- Unlock %: `u32` in basis points, 0–10000 (`BPS_DENOMINATOR`)
- Multiplier comparisons: scaled by 10000 to match BPS (`MULT_5X = 50000`)
- Division always rounds DOWN (conservative — never accidentally unlock more)
- Use `checked_*` arithmetic everywhere; saturating only where overflow is functionally meaningless
