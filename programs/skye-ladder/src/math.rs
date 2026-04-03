use crate::errors::SkyeLadderError;
use crate::state::{Position, PRICE_SCALE, USD_SCALE, BPS_DENOMINATOR};
use anchor_lang::prelude::*;

/// Internal multiplier precision: we compute mult * 10_000 so 1x = 10_000, 2x = 20_000, etc.
/// This gives 0.01% granularity on the multiplier which is more than sufficient.
const MULT_SCALE: u128 = 10_000;

/// Milestone snap epsilon in mult-scaled units.
/// 50 = 0.5% tolerance around exact milestone boundaries to handle AMM rounding.
const EPSILON: u128 = 50;

/// Phase boundary constants in mult-scaled units.
const MULT_1X: u128 = 10_000;
const MULT_2X: u128 = 20_000;
const MULT_5X: u128 = 50_000;
const MULT_10X: u128 = 100_000;
const MULT_15X: u128 = 150_000;

/// BPS constants for milestone values.
const BPS_50: u128 = 5_000;   // 50% at 2x
const BPS_62_5: u128 = 6_250; // 62.5% at 5x
const BPS_75: u128 = 7_500;   // 75% at 10x
const BPS_100: u128 = 10_000; // 100% at 15x+

/// Calculate the unlocked basis points for a single position at the given price.
///
/// Returns a value in [0, 10_000] representing what percentage of the position's
/// token_balance is sellable. All arithmetic is u128 fixed-point, rounding DOWN
/// (conservative — never accidentally unlock more than earned).
///
/// # Phases
/// - Underwater (mult <= 1x): 100% sellable — no one is ever trapped
/// - Phase 1 (1x–2x): Sell back initial USD investment
/// - Phase 2 (2x–5x): 50% + compressed growth → cliff to 62.5% at 5x
/// - Phase 3 (5x–10x): 62.5% + compressed growth → cliff to 75% at 10x
/// - Phase 4 (10x–15x): 75% + compressed growth → cliff to 100% at 15x
/// - Phase 5 (15x+): 100% unlocked
pub fn calculate_unlocked_bps(
    current_price: u64,
    position: &Position,
) -> Result<u32> {
    require!(current_price > 0, SkyeLadderError::ZeroPrice);
    require!(position.entry_price > 0, SkyeLadderError::ZeroPrice);
    require!(position.token_balance > 0, SkyeLadderError::ZeroTokens);

    let cp = current_price as u128;
    let ep = position.entry_price as u128;

    // mult_scaled = multiplier * MULT_SCALE (integer)
    // e.g. 2.5x → 25_000
    let mult_scaled = cp
        .checked_mul(MULT_SCALE)
        .ok_or(SkyeLadderError::MathOverflow)?
        .checked_div(ep)
        .ok_or(SkyeLadderError::MathOverflow)?;

    // ── Underwater: mult <= 1.0 → 100% sellable ──
    if mult_scaled <= MULT_1X {
        return Ok(BPS_DENOMINATOR); // 10_000
    }

    // ── Phase 1: 1x < mult < 2x → sell back initial USD ──
    if mult_scaled < MULT_2X {
        return phase1_unlock(current_price, position);
    }

    // ── 5x milestone snap (within epsilon) ──
    if mult_scaled >= MULT_5X.saturating_sub(EPSILON)
        && mult_scaled < MULT_5X.saturating_add(EPSILON)
    {
        return Ok(BPS_62_5 as u32);
    }

    // ── Phase 2: 2x ≤ mult < 5x → 50% + compressed growth ──
    if mult_scaled < MULT_5X {
        // progress: 0 at 2x, 30_000 at 5x (in mult_scaled units)
        // growth: (mult - 2) / (5 - 2) * 12.5% * 0.5 = progress/30_000 * 625 bps
        let progress = mult_scaled - MULT_2X;
        let growth = progress
            .checked_mul(BPS_62_5 - BPS_50)
            .ok_or(SkyeLadderError::MathOverflow)?
            .checked_div(MULT_5X - MULT_2X)
            .ok_or(SkyeLadderError::MathOverflow)?;
        // Compressed: half the growth rate
        let compressed = growth / 2;
        let bps = BPS_50 + compressed;
        return Ok(bps as u32);
    }

    // ── 10x milestone snap ──
    if mult_scaled >= MULT_10X.saturating_sub(EPSILON)
        && mult_scaled < MULT_10X.saturating_add(EPSILON)
    {
        return Ok(BPS_75 as u32);
    }

    // ── Phase 3: 5x ≤ mult < 10x → 62.5% + compressed growth ──
    if mult_scaled < MULT_10X {
        let progress = mult_scaled - MULT_5X;
        let growth = progress
            .checked_mul(BPS_75 - BPS_62_5)
            .ok_or(SkyeLadderError::MathOverflow)?
            .checked_div(MULT_10X - MULT_5X)
            .ok_or(SkyeLadderError::MathOverflow)?;
        let compressed = growth / 2;
        let bps = BPS_62_5 + compressed;
        return Ok(bps as u32);
    }

    // ── Phase 5: mult >= 15x → 100% unlocked ──
    if mult_scaled >= MULT_15X {
        return Ok(BPS_100 as u32);
    }

    // ── Phase 4: 10x ≤ mult < 15x → 75% + compressed growth ──
    let progress = mult_scaled - MULT_10X;
    let growth = progress
        .checked_mul(BPS_100 - BPS_75)
        .ok_or(SkyeLadderError::MathOverflow)?
        .checked_div(MULT_15X - MULT_10X)
        .ok_or(SkyeLadderError::MathOverflow)?;
    let compressed = growth / 2;
    let bps = BPS_75 + compressed;
    Ok(bps as u32)
}

/// Phase 1: sell back initial USD value.
///
/// sellable_ratio = initial_usd / (token_balance × current_price_in_usd)
///
/// Since initial_usd is scaled by USD_SCALE (10^6) and current_price is scaled
/// by PRICE_SCALE (10^18), we compute:
///
///   bps = initial_usd × PRICE_SCALE × BPS_DENOMINATOR / (token_balance × current_price)
///
/// This naturally cancels the USD_SCALE in initial_usd with the price scaling,
/// because initial_usd = tokens_bought × entry_price / PRICE_SCALE × USD_SCALE,
/// and we're dividing by token_balance × current_price.
///
/// All intermediate math uses u128. Result is capped at 10_000 bps.
fn phase1_unlock(current_price: u64, position: &Position) -> Result<u32> {
    let initial_usd = position.initial_usd as u128;
    // Use original_balance to prevent the repeated-sell bypass.
    // Legacy positions may have garbage — detect by checking original >= balance.
    let token_balance = if position.original_balance >= position.token_balance {
        position.original_balance as u128
    } else {
        position.token_balance as u128
    };
    let cp = current_price as u128;
    let bps_denom = BPS_DENOMINATOR as u128;

    // sellable_ratio = initial_usd_dollars / position_value_dollars
    //
    // initial_usd is in USD × USD_SCALE (10^6).
    // position_value = token_balance × current_price / PRICE_SCALE (in raw USD).
    // To get position_value in USD_SCALE: token_balance × current_price × USD_SCALE / PRICE_SCALE.
    //
    // bps = initial_usd × PRICE_SCALE × BPS_DENOM / (token_balance × current_price × USD_SCALE)
    let numerator = initial_usd
        .checked_mul(PRICE_SCALE)
        .ok_or(SkyeLadderError::MathOverflow)?
        .checked_mul(bps_denom)
        .ok_or(SkyeLadderError::MathOverflow)?;

    let denominator = token_balance
        .checked_mul(cp)
        .ok_or(SkyeLadderError::MathOverflow)?
        .checked_mul(USD_SCALE)
        .ok_or(SkyeLadderError::MathOverflow)?;

    require!(denominator > 0, SkyeLadderError::ZeroTokens);

    // Integer division rounds DOWN (conservative)
    let bps = numerator / denominator;

    // Cap at 100%
    Ok(bps.min(BPS_100) as u32)
}

/// Apply the high-water mark: effective unlock is max(calculated, stored).
/// Updates the position's unlocked_bps in place and returns the effective value.
pub fn effective_unlock_bps(
    current_price: u64,
    position: &mut Position,
) -> Result<u32> {
    let raw = calculate_unlocked_bps(current_price, position)?;
    let effective = raw.max(position.unlocked_bps);
    position.unlocked_bps = effective;
    Ok(effective)
}

/// Calculate how many tokens are sellable from a position at the given price.
/// Returns (sellable_tokens, effective_bps).
///
/// Sellable is computed from ORIGINAL balance, not current balance:
///   max_sellable = original_balance * bps / 10_000
///   already_sold = original_balance - token_balance
///   sellable_now = max_sellable - already_sold
///
/// This prevents the repeated-small-sell bypass where each sell recalculates
/// a percentage of a shrinking balance.
pub fn sellable_tokens(
    current_price: u64,
    position: &mut Position,
) -> Result<(u64, u32)> {
    let bps = effective_unlock_bps(current_price, position)?;
    let bps_denom = BPS_DENOMINATOR as u128;

    // Use original_balance if valid, otherwise fall back to token_balance.
    // Legacy positions (created before the original_balance field was added)
    // may have garbage in this field. Detect by checking original >= balance.
    let original = if position.original_balance >= position.token_balance {
        position.original_balance as u128
    } else {
        position.token_balance as u128
    };

    let max_sellable = original
        .checked_mul(bps as u128)
        .ok_or(SkyeLadderError::MathOverflow)?
        / bps_denom;

    let already_sold = original.saturating_sub(position.token_balance as u128);
    let sellable_now = max_sellable.saturating_sub(already_sold);

    // Can't sell more than currently held
    let capped = sellable_now.min(position.token_balance as u128);

    Ok((capped as u64, bps))
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: create a position. initial_usd is auto-computed as
    /// tokens × entry_price × USD_SCALE / PRICE_SCALE, matching on_buy behavior.
    fn make_position(entry_price_f: f64, tokens: u64, _initial_usd_f: f64) -> Position {
        let ep = (entry_price_f * PRICE_SCALE as f64) as u64;
        let iusd = (tokens as f64 * entry_price_f * USD_SCALE as f64) as u64;
        Position {
            entry_price: ep,
            initial_usd: iusd,
            token_balance: tokens,
            unlocked_bps: 0,
            original_balance: tokens,
        }
    }

    /// Helper: compute current_price as a multiple of entry_price.
    fn price_at_mult(entry_price: u64, mult: f64) -> u64 {
        ((entry_price as f64) * mult) as u64
    }

    // ── Underwater tests ──

    #[test]
    fn test_underwater_exact_entry() {
        // At entry price: mult = 1.0 → 100% sellable
        let pos = make_position(0.000003, 1_000_000_000, 3.0);
        let bps = calculate_unlocked_bps(pos.entry_price, &pos).unwrap();
        assert_eq!(bps, 10_000);
    }

    #[test]
    fn test_underwater_below_entry() {
        // Below entry: mult < 1.0 → 100% sellable
        let pos = make_position(0.000003, 1_000_000_000, 3.0);
        let price = price_at_mult(pos.entry_price, 0.5);
        let bps = calculate_unlocked_bps(price, &pos).unwrap();
        assert_eq!(bps, 10_000);
    }

    #[test]
    fn test_underwater_99_percent() {
        let pos = make_position(0.000003, 1_000_000_000, 3.0);
        let price = price_at_mult(pos.entry_price, 0.99);
        let bps = calculate_unlocked_bps(price, &pos).unwrap();
        assert_eq!(bps, 10_000);
    }

    // ── Phase 1 tests (1x to 2x) ──

    #[test]
    fn test_phase1_just_above_entry() {
        // At 1.01x, should be able to sell ~99% (initial_usd / current_value)
        // initial_usd = $3, current_value = $3.03
        // sellable = 3/3.03 ≈ 99.01%
        let pos = make_position(0.000003, 1_000_000_000, 3.0);
        let price = price_at_mult(pos.entry_price, 1.01);
        let bps = calculate_unlocked_bps(price, &pos).unwrap();
        // Should be close to 9901 bps
        assert!(bps >= 9_895 && bps <= 9_910, "Got {}", bps);
    }

    #[test]
    fn test_phase1_at_1_5x() {
        // At 1.5x: sellable = initial_usd / (tokens * 1.5 * entry)
        // = initial_usd / (initial_usd * 1.5) = 1/1.5 ≈ 66.67%
        let pos = make_position(0.000003, 1_000_000_000, 3.0);
        let price = price_at_mult(pos.entry_price, 1.5);
        let bps = calculate_unlocked_bps(price, &pos).unwrap();
        // Should be ~6666 bps
        assert!(bps >= 6_660 && bps <= 6_670, "Got {}", bps);
    }

    #[test]
    fn test_phase1_approaching_2x() {
        // At 1.99x: sellable ≈ 1/1.99 ≈ 50.25%
        let pos = make_position(0.000003, 1_000_000_000, 3.0);
        let price = price_at_mult(pos.entry_price, 1.99);
        let bps = calculate_unlocked_bps(price, &pos).unwrap();
        assert!(bps >= 5_020 && bps <= 5_030, "Got {}", bps);
    }

    // ── Phase 2 tests (2x to 5x, compressed) ──

    #[test]
    fn test_phase2_at_2x() {
        // At exactly 2x: 50% (boundary of Phase 1 → Phase 2)
        let pos = make_position(0.000003, 1_000_000_000, 3.0);
        let price = price_at_mult(pos.entry_price, 2.0);
        let bps = calculate_unlocked_bps(price, &pos).unwrap();
        // At 2x, the code takes the Phase 2 branch: base 5000 + 0 growth
        assert_eq!(bps, 5_000);
    }

    #[test]
    fn test_phase2_at_3_5x() {
        // At 3.5x: 5000 + (1.5/3 * 1250 / 2) = 5000 + 312 = 5312
        // progress = 15000 (out of 30000)
        // growth = 15000 * 1250 / 30000 = 625
        // compressed = 625 / 2 = 312
        let pos = make_position(0.000003, 1_000_000_000, 3.0);
        let price = price_at_mult(pos.entry_price, 3.5);
        let bps = calculate_unlocked_bps(price, &pos).unwrap();
        assert_eq!(bps, 5_312);
    }

    #[test]
    fn test_phase2_just_below_5x() {
        // At 4.99x: should be close to max Phase 2 but below 5x cliff
        // progress ≈ 29_900 / 30_000 * 1250 / 2 ≈ 622
        let pos = make_position(0.000003, 1_000_000_000, 3.0);
        let price = price_at_mult(pos.entry_price, 4.99);
        let bps = calculate_unlocked_bps(price, &pos).unwrap();
        // Should be close to 5000 + 623 = 5623 but NOT 6250
        assert!(bps >= 5_620 && bps <= 5_625, "Got {}", bps);
        assert!(bps < 6_250, "Should be below 5x cliff");
    }

    // ── 5x milestone snap ──

    #[test]
    fn test_5x_milestone_exact() {
        let pos = make_position(0.000003, 1_000_000_000, 3.0);
        let price = price_at_mult(pos.entry_price, 5.0);
        let bps = calculate_unlocked_bps(price, &pos).unwrap();
        assert_eq!(bps, 6_250);
    }

    // ── Phase 3 tests (5x to 10x, compressed) ──

    #[test]
    fn test_phase3_at_7_5x() {
        // At 7.5x: 6250 + (2.5/5 * 1250 / 2) = 6250 + 312
        let pos = make_position(0.000003, 1_000_000_000, 3.0);
        let price = price_at_mult(pos.entry_price, 7.5);
        let bps = calculate_unlocked_bps(price, &pos).unwrap();
        assert_eq!(bps, 6_562);
    }

    #[test]
    fn test_phase3_just_below_10x() {
        let pos = make_position(0.000003, 1_000_000_000, 3.0);
        let price = price_at_mult(pos.entry_price, 9.99);
        let bps = calculate_unlocked_bps(price, &pos).unwrap();
        assert!(bps >= 6_870 && bps <= 6_875, "Got {}", bps);
        assert!(bps < 7_500, "Should be below 10x cliff");
    }

    // ── 10x milestone snap ──

    #[test]
    fn test_10x_milestone_exact() {
        let pos = make_position(0.000003, 1_000_000_000, 3.0);
        let price = price_at_mult(pos.entry_price, 10.0);
        let bps = calculate_unlocked_bps(price, &pos).unwrap();
        assert_eq!(bps, 7_500);
    }

    // ── Phase 4 tests (10x to 15x, compressed) ──

    #[test]
    fn test_phase4_at_12_5x() {
        // At 12.5x: 7500 + (2.5/5 * 2500 / 2) = 7500 + 625
        let pos = make_position(0.000003, 1_000_000_000, 3.0);
        let price = price_at_mult(pos.entry_price, 12.5);
        let bps = calculate_unlocked_bps(price, &pos).unwrap();
        assert_eq!(bps, 8_125);
    }

    #[test]
    fn test_phase4_just_below_15x() {
        let pos = make_position(0.000003, 1_000_000_000, 3.0);
        let price = price_at_mult(pos.entry_price, 14.99);
        let bps = calculate_unlocked_bps(price, &pos).unwrap();
        // Compressed: 7500 + (4.99/5 * 2500 / 2) = 7500 + 1247 = 8747
        assert!(bps >= 8_740 && bps <= 8_750, "Got {}", bps);
        assert!(bps < 10_000, "Should be below 15x cliff");
    }

    // ── Phase 5 tests (15x+) ──

    #[test]
    fn test_phase5_at_15x() {
        let pos = make_position(0.000003, 1_000_000_000, 3.0);
        let price = price_at_mult(pos.entry_price, 15.0);
        let bps = calculate_unlocked_bps(price, &pos).unwrap();
        assert_eq!(bps, 10_000);
    }

    #[test]
    fn test_phase5_at_100x() {
        let pos = make_position(0.000003, 1_000_000_000, 3.0);
        let price = price_at_mult(pos.entry_price, 100.0);
        let bps = calculate_unlocked_bps(price, &pos).unwrap();
        assert_eq!(bps, 10_000);
    }

    // ── High-water mark tests ──

    #[test]
    fn test_high_water_mark_preserves_on_dip() {
        let mut pos = make_position(0.000003, 1_000_000_000, 3.0);

        // Price goes to 5x → unlock at 6250
        let price_5x = price_at_mult(pos.entry_price, 5.0);
        let bps = effective_unlock_bps(price_5x, &mut pos).unwrap();
        assert_eq!(bps, 6_250);
        assert_eq!(pos.unlocked_bps, 6_250);

        // Price dips to 3x → raw would be ~5312, but high-water keeps 6250
        let price_3x = price_at_mult(pos.entry_price, 3.0);
        let bps = effective_unlock_bps(price_3x, &mut pos).unwrap();
        assert_eq!(bps, 6_250);
        assert_eq!(pos.unlocked_bps, 6_250);
    }

    #[test]
    fn test_high_water_mark_increases() {
        let mut pos = make_position(0.000003, 1_000_000_000, 3.0);

        let price_5x = price_at_mult(pos.entry_price, 5.0);
        effective_unlock_bps(price_5x, &mut pos).unwrap();
        assert_eq!(pos.unlocked_bps, 6_250);

        // Price goes to 10x → should increase to 7500
        let price_10x = price_at_mult(pos.entry_price, 10.0);
        let bps = effective_unlock_bps(price_10x, &mut pos).unwrap();
        assert_eq!(bps, 7_500);
        assert_eq!(pos.unlocked_bps, 7_500);
    }

    // ── Sellable tokens tests ──

    #[test]
    fn test_sellable_tokens_at_5x() {
        let mut pos = make_position(0.000003, 1_000_000_000, 3.0);
        let price = price_at_mult(pos.entry_price, 5.0);
        let (sellable, bps) = sellable_tokens(price, &mut pos).unwrap();
        assert_eq!(bps, 6_250);
        // 62.5% of 1B = 625M
        assert_eq!(sellable, 625_000_000);
    }

    #[test]
    fn test_sellable_tokens_underwater() {
        let mut pos = make_position(0.000003, 1_000_000_000, 3.0);
        let price = price_at_mult(pos.entry_price, 0.5);
        let (sellable, bps) = sellable_tokens(price, &mut pos).unwrap();
        assert_eq!(bps, 10_000);
        assert_eq!(sellable, 1_000_000_000);
    }

    // ── Edge cases ──

    #[test]
    fn test_zero_price_errors() {
        let pos = make_position(0.000003, 1_000_000_000, 3.0);
        let result = calculate_unlocked_bps(0, &pos);
        assert!(result.is_err());
    }

    #[test]
    fn test_zero_entry_price_errors() {
        let pos = Position {
            entry_price: 0,
            initial_usd: 3_000_000,
            token_balance: 1_000_000_000,
            unlocked_bps: 0,
            original_balance: 1_000_000_000,
        };
        let result = calculate_unlocked_bps(1000, &pos);
        assert!(result.is_err());
    }

    #[test]
    fn test_very_small_position() {
        // 1 token, tiny price — initial_usd = 1 * 1000 * USD_SCALE / PRICE_SCALE
        // That's basically 0 in USD_SCALE, so use a manually consistent value.
        let ep = 1_000_000_000_000u64; // 10^12 = $0.000001 * PRICE_SCALE
        let pos = Position {
            entry_price: ep,
            initial_usd: 1,
            token_balance: 1,
            unlocked_bps: 0,
            original_balance: 1,
        };
        let price = ep * 2; // 2x
        let bps = calculate_unlocked_bps(price, &pos).unwrap();
        assert_eq!(bps, 5_000);
    }

    #[test]
    fn test_sellable_from_original_not_remaining() {
        // After selling some tokens, sellable is computed from ORIGINAL balance.
        // At 1.5x, unlock = 1/1.5 = 66.67%.
        // Original = 1B, so max_sellable = 666M.
        // If we already sold 300M (balance = 700M), sellable_now = 666M - 300M = 366M.
        let mut pos = make_position(0.000003, 1_000_000_000, 3.0);
        let price = price_at_mult(pos.entry_price, 1.5);

        // Full sellable from original
        let (sellable_full, _) = sellable_tokens(price, &mut pos).unwrap();
        assert!(sellable_full >= 666_000_000 && sellable_full <= 667_000_000,
            "Full sellable: {}", sellable_full);

        // Simulate having sold 300M (balance reduced, original stays)
        pos.token_balance = 700_000_000;
        // original_balance stays at 1_000_000_000

        let (sellable_after, _) = sellable_tokens(price, &mut pos).unwrap();
        // max_sellable = 1B * 66.67% = 666M, already_sold = 300M, so 366M left
        assert!(sellable_after >= 366_000_000 && sellable_after <= 367_000_000,
            "Sellable after partial: {}", sellable_after);

        // Total sold would be 300M + 366M = 666M = exactly the unlock limit
    }

    #[test]
    fn test_repeated_sells_cannot_drain_position() {
        // This test verifies the fix for the critical bug where repeated
        // small sells could drain 100% of a position.
        let mut pos = make_position(0.000003, 1_000_000_000, 3.0);
        let price = price_at_mult(pos.entry_price, 1.5); // 66.67% unlock

        let mut total_sold: u64 = 0;
        for _ in 0..20 {
            if pos.token_balance == 0 { break; }
            let (sellable, _) = sellable_tokens(price, &mut pos).unwrap();
            if sellable == 0 { break; }
            let sell = sellable.min(100_000_000); // sell 100M at a time
            pos.token_balance -= sell;
            total_sold += sell;
        }

        // Should have sold ~666M total (66.67% of 1B), NOT all 1B
        assert!(total_sold >= 660_000_000 && total_sold <= 670_000_000,
            "Total sold: {} (should be ~666M)", total_sold);
        assert!(pos.token_balance >= 330_000_000,
            "Remaining: {} (should be ~333M)", pos.token_balance);
    }

    // ── Compressed growth verification ──

    #[test]
    fn test_compressed_growth_is_half_of_linear() {
        // Between 2x and 5x, full linear would go 5000 → 6250 (1250 bps over the range).
        // Compressed = half rate, so at midpoint (3.5x) we should get 5000 + 312 not 5000 + 625.
        let pos = make_position(0.000003, 1_000_000_000, 3.0);

        let mid = price_at_mult(pos.entry_price, 3.5);
        let bps = calculate_unlocked_bps(mid, &pos).unwrap();

        // Full linear at midpoint: 5000 + 625 = 5625
        // Compressed at midpoint: 5000 + 312 = 5312
        assert_eq!(bps, 5_312, "Should be half of full linear growth");
    }

    #[test]
    fn test_cliff_jumps_at_milestones() {
        let pos = make_position(0.000003, 1_000_000_000, 3.0);

        // Just below 5x (4.99x) → compressed Phase 2
        let price_4_99 = price_at_mult(pos.entry_price, 4.99);
        let below_5x = calculate_unlocked_bps(price_4_99, &pos).unwrap();

        // At 5x → cliff jump
        let price_5x = price_at_mult(pos.entry_price, 5.0);
        let at_5x = calculate_unlocked_bps(price_5x, &pos).unwrap();

        // The cliff should be a significant jump
        let cliff_jump = at_5x - below_5x;
        assert!(cliff_jump >= 620, "5x cliff jump should be ~625 bps, got {}", cliff_jump);

        // Same pattern at 10x
        let price_9_99 = price_at_mult(pos.entry_price, 9.99);
        let below_10x = calculate_unlocked_bps(price_9_99, &pos).unwrap();
        let price_10x = price_at_mult(pos.entry_price, 10.0);
        let at_10x = calculate_unlocked_bps(price_10x, &pos).unwrap();
        let cliff_10 = at_10x - below_10x;
        assert!(cliff_10 >= 620, "10x cliff jump should be ~625 bps, got {}", cliff_10);
    }

    // ── Monotonicity test ──

    #[test]
    fn test_unlock_monotonically_increases_with_price() {
        let pos = make_position(0.000003, 1_000_000_000, 3.0);

        let mults = [
            0.5, 0.99, 1.0, 1.01, 1.5, 1.99,
            2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 4.99,
            5.0, 5.5, 6.0, 7.0, 8.0, 9.0, 9.99,
            10.0, 11.0, 12.0, 13.0, 14.0, 14.99,
            15.0, 20.0, 50.0, 100.0,
        ];

        let mut prev_bps = 0u32;
        let mut prev_mult = 0.0f64;

        for &m in &mults {
            let price = price_at_mult(pos.entry_price, m);
            if price == 0 {
                continue;
            }
            let bps = calculate_unlocked_bps(price, &pos).unwrap();

            // Note: Phase 1 can decrease as mult goes from 1→2 (ratio decreases),
            // so we only check monotonicity from 2x onward.
            if m >= 2.0 && prev_mult >= 2.0 {
                assert!(
                    bps >= prev_bps,
                    "Not monotonic: {}x → {} bps, but {}x → {} bps",
                    prev_mult, prev_bps, m, bps
                );
            }

            prev_bps = bps;
            prev_mult = m;
        }
    }
}
