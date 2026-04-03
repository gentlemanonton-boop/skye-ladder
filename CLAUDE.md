# Skye Ladder — Solana Token-2022 Transfer Hook

## What This Is

A structured sell-restriction token on Solana. The transfer hook enforces per-wallet, rule-based sell limits that scale with price appreciation. Buys are always unrestricted. Only sells are gated.

The goal: break the volume-churn cycle where flippers accumulate supply at low MC and sell into buy volume at 2-4x, creating an artificial ceiling that kills most tokens below $300K MC.

## Token Parameters

- **Supply:** 1,000,000,000 tokens (fixed, no mint)
- **Launch MC:** ~$3,000
- **Launch platform:** Meteora DLMM (requires Token-2022)
- **Program:** Solana Token-2022 with Transfer Hook extension
- **Framework:** Anchor 0.31+
- **Price feed:** Spot price from AMM pool (NO oracle, NO TWAP)

## The Sell Rules (Skye Ladder)

Milestone-based unlocking with **compressed growth (-50%) between milestones**. At each milestone, sellable % jumps. Between milestones, it grows at half rate.

### Phase 1: 1x → 2x (Get Your Money Back)
- Sell back initial investment in USD value at any time
- Formula: `sellable = initial_usd / (token_balance × current_price)`
- Natural taper from ~100% near entry to exactly 50% at 2x
- **Anyone at or below entry price can ALWAYS sell 100%**

### Phase 2: 2x → 5x (Compressed Growth)
- Milestone values: 50% at 2x, 62.5% at 5x
- Between: `sellable = 0.50 + ((mult - 2) / 3 × 0.125 × 0.5)`
- Growth is HALVED between milestones
- At 3.5x: ~53.1% (not 56.25% like full linear)
- **Cliff jump to 62.5% when 5x is reached**

### Phase 3: 5x → 10x (Compressed Growth)
- Milestone values: 62.5% at 5x, 75% at 10x
- Between: `sellable = 0.625 + ((mult - 5) / 5 × 0.125 × 0.5)`
- **Cliff jump to 75% when 10x is reached**

### Phase 4: 10x → 15x (Compressed Growth)
- Milestone values: 75% at 10x, 100% at 15x
- Between: `sellable = 0.75 + ((mult - 10) / 5 × 0.25 × 0.5)`
- **Cliff jump to 100% when 15x is reached**

### Phase 5: 15x+
- 100% unlocked. No restrictions.

## Critical Rules

### 1. Each buy is an INDEPENDENT position
Every buy creates a separate position with its own entry_price, initial_usd, token_balance, and unlock level. Later buys CANNOT unlock earlier positions.

### 2. Remaining balance is always the base
All % calculations use current token_balance of each position, not original buy amount. If you sell 80% of a position, the remaining 20% is the new base.

### 3. High-water mark never decreases
Each position's unlocked_bps is a high-water mark. If you earned 60% unlock and price dips, you keep 60%.

### 4. Sells deduct from highest multiplier first
When selling, iterate positions from highest mult to lowest. Sell the most-unlocked tokens first.

### 5. Underwater = 100% sellable
If current_price <= entry_price for a position, that position is fully sellable. No one is EVER trapped.

### 6. Transfers = sell + new position
Wallet-to-wallet transfers: sender must pass unlock check (treated as sell). Receiver gets a new position at current spot price.

### 7. Price is SPOT, not TWAP
Read spot price directly from the AMM pool at time of sell. No oracle needed. Flash loan manipulation is a non-issue because every wallet's milestones are at different absolute prices.

### 8. Pool address is whitelisted
AMM pool address bypasses the hook entirely (for LP add/remove).

## Position Management

### Per-Wallet PDA Schema (Fixed-Point Math)
```rust
pub struct WalletRecord {
    pub positions: Vec<Position>, // max 10
}

pub struct Position {
    pub entry_price: u64,     // price × 10^18
    pub initial_usd: u64,     // USD × 10^6
    pub token_balance: u64,   // raw token amount
    pub unlocked_bps: u32,    // basis points 0-10000, high-water mark
}
```

### Position Merging Rules
- **Proximity merge:** New buy within 10% of existing position's entry_price → merge (weighted avg entry, sum initial_usd, keep higher unlocked_bps)
- **Phase 5 merge:** All positions at 15x+ are consolidated (fully unlocked, no need to track separately)
- **Hard cap:** Max 10 positions per wallet. If exceeded, merge the two closest positions.

## Core Pseudocode

### calculate_unlocked(current_price, position) → bps
```
mult = current_price / position.entry_price

if mult <= 1.0:
    // Underwater: 100% sellable
    return 10000

if mult < 2.0:
    // Phase 1: sell initial USD back
    return min(position.initial_usd / (position.token_balance * current_price) * 10000, 10000)

if mult >= 5.0 - epsilon and mult < 5.0 + epsilon:
    return 6250  // 5x milestone snap

if mult < 5.0:
    // Phase 2: compressed
    t = (mult - 2.0) / 3.0
    return 5000 + (t * 1250 * 0.5)  // half growth rate

if mult >= 10.0 - epsilon and mult < 10.0 + epsilon:
    return 7500  // 10x milestone snap

if mult < 10.0:
    // Phase 3: compressed
    t = (mult - 5.0) / 5.0
    return 6250 + (t * 1250 * 0.5)

if mult >= 15.0:
    return 10000  // Phase 5: fully unlocked

// Phase 4: compressed
t = (mult - 10.0) / 5.0
return 7500 + (t * 2500 * 0.5)
```

### on_buy(wallet, tokens_bought, current_price)
```
new_position = Position {
    entry_price: current_price,
    initial_usd: tokens_bought * current_price,
    token_balance: tokens_bought,
    unlocked_bps: 0,
}

// Try merge with nearby position (within 10%)
for pos in wallet.positions:
    if abs(pos.entry_price - current_price) / pos.entry_price < 0.10:
        total_cost = pos.initial_usd + new_position.initial_usd
        total_tokens = pos.token_balance + tokens_bought
        pos.entry_price = total_cost / total_tokens
        pos.initial_usd = total_cost
        pos.token_balance = total_tokens
        return

// Check cap
if len(wallet.positions) >= 10:
    merge_closest_pair(wallet.positions)

wallet.positions.push(new_position)
```

### on_sell(wallet, tokens_to_sell, current_price) — Transfer Hook
```
// Sort positions by multiplier descending (sell most-unlocked first)
sorted = sort_by_mult_desc(wallet.positions, current_price)

remaining = tokens_to_sell
for pos in sorted:
    if remaining <= 0: break

    raw_unlock = calculate_unlocked(current_price, pos)
    effective = max(raw_unlock, pos.unlocked_bps)
    pos.unlocked_bps = effective

    sellable = pos.token_balance * effective / 10000
    take = min(sellable, remaining)
    pos.token_balance -= take
    remaining -= take

if remaining > 0:
    REVERT  // trying to sell more than allowed

// Clean up empty positions
wallet.positions.retain(|p| p.token_balance > 0)
```

## Anti-Bundle Protection (Light)

Per-block buy limits at low MC:

| MC Range | Max buy per wallet per block |
|---|---|
| Under $5K | $100 |
| $5K-$10K | $250 |
| $10K-$25K | $500 |
| $25K-$50K | $1,000 |
| Above $50K | No limit |

## Transfer Classification

| Transfer Type | Sender Rule | Receiver Rule |
|---|---|---|
| Buy (Pool → Wallet) | Whitelisted, skip | Create new position at spot price |
| Sell (Wallet → Pool) | Enforce unlock per position | Whitelisted, skip |
| Wallet → Wallet | Enforce as sell (must pass unlock) | Create new position at spot price |
| LP operations | Whitelisted both sides, skip | Skip |

## Security Considerations

- **Multi-wallet splitting:** Transfer = sell (must pass unlock) + new position for receiver
- **Position dilution:** Each buy is independent, cannot unlock earlier positions
- **Flash loan manipulation:** Every wallet's milestones at different prices, targeting one is pointless
- **Bundling:** Per-block limits + compressed unlock between milestones
- **Reentrancy:** Follow checks-effects-interactions pattern
- **Math:** All fixed-point u64/u32, checked arithmetic, round DOWN for unlocks (conservative)
- **Compute budget:** Max 10 positions × simple arithmetic per sell, fits within Solana limits

## Build Sequence

1. Scaffold Anchor project with Token-2022 Transfer Hook
2. Implement core unlock calculation with compressed milestones
3. Add single-position sell restriction (MVP)
4. Add multi-position tracking with merging
5. Add sell-order priority (highest mult first)
6. Add transfer classification (buy/sell/wallet-to-wallet)
7. Add per-block buy limits
8. Add pool address whitelist
9. Deploy to devnet, create test Meteora pool
10. Write comprehensive tests (50+ cases)
11. Fuzz testing (10,000+ random scenarios)
12. Bug bounty / security review
13. Mainnet deploy

## Important Notes

- ALL math is fixed-point. No f64 on-chain.
- Use u64 scaled by 10^18 for prices, 10^6 for USD amounts, raw for token amounts
- unlocked_bps is u32 in basis points (0-10000)
- Division always rounds DOWN (conservative — never accidentally unlock more)
- The spot price comes from reading the pool's token ratio, not an oracle
- The program should be upgradeable initially, with authority freeze after confidence
