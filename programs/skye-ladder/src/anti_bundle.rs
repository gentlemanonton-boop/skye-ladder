use crate::errors::SkyeLadderError;
use crate::state::{WalletRecord, PRICE_SCALE, USD_SCALE};
use anchor_lang::prelude::*;

/// Token supply in RAW units: 1 billion tokens × 10^9 decimals = 10^18.
/// Must match the actual raw supply to compute MC from raw-unit prices.
const TOKEN_SUPPLY_RAW: u128 = 1_000_000_000_000_000_000;

/// SOL lamports per SOL (10^9).
const LAMPORTS_PER_SOL: u128 = 1_000_000_000;

/// Per-block buy limit tiers.
/// Each tier: (max_mc_usd_scaled, max_buy_usd_scaled)
/// MC and buy limits are in USD × 10^6 (USD_SCALE).
///
/// | MC Range       | Max buy per wallet per block |
/// |----------------|-----------------------------|
/// | Under $5K      | $100                        |
/// | $5K–$10K       | $250                        |
/// | $10K–$25K      | $500                        |
/// | $25K–$50K      | $1,000                      |
/// | Above $50K     | No limit                    |
const TIERS: [(u128, u128); 4] = [
    (5_000 * USD_SCALE, 100 * USD_SCALE),       // <$5K MC → $100 limit
    (10_000 * USD_SCALE, 250 * USD_SCALE),      // <$10K MC → $250 limit
    (25_000 * USD_SCALE, 500 * USD_SCALE),      // <$25K MC → $500 limit
    (50_000 * USD_SCALE, 1_000 * USD_SCALE),    // <$50K MC → $1,000 limit
];

/// Check and enforce per-block buy limits based on current market cap.
///
/// - `wallet`: the buyer's WalletRecord (tracks slot accumulation)
/// - `buy_usd`: the USD value of this buy, scaled by 10^6
/// - `current_price`: spot price in SOL, scaled by PRICE_SCALE (10^18)
/// - `sol_price_usd`: SOL/USD price, scaled by USD_SCALE (10^6). 0 = skip limits.
/// - `current_slot`: the current Solana slot
///
/// Updates `wallet.last_buy_slot` and `wallet.slot_buy_usd` in place.
/// Returns `Ok(())` if the buy is within limits, or `BuyLimitExceeded` error.
pub fn enforce_buy_limit(
    wallet: &mut WalletRecord,
    buy_usd: u64,
    current_price: u64,
    sol_price_usd: u64,
    current_slot: u64,
) -> Result<()> {
    // If sol_price_usd is not set, skip anti-bundle limits
    if sol_price_usd == 0 {
        return Ok(());
    }

    // Compute market cap in USD × 10^6
    // price from pool is SOL-lamports per raw-token, scaled by PRICE_SCALE.
    // mc = TOKEN_SUPPLY * price * sol_price_usd / (PRICE_SCALE * LAMPORTS_PER_SOL)
    // Split into two divisions to avoid overflow:
    //   step1 = TOKEN_SUPPLY * price / PRICE_SCALE  (value in SOL-lamports per human-token)
    //   step2 = step1 * sol_price_usd / LAMPORTS_PER_SOL (value in USD_SCALE)
    let mc_sol_lamports = TOKEN_SUPPLY_RAW
        .checked_mul(current_price as u128)
        .ok_or(SkyeLadderError::MathOverflow)?
        .checked_div(PRICE_SCALE)
        .ok_or(SkyeLadderError::MathOverflow)?;
    let mc_usd = mc_sol_lamports
        .checked_mul(sol_price_usd as u128)
        .ok_or(SkyeLadderError::MathOverflow)?
        .checked_div(LAMPORTS_PER_SOL)
        .ok_or(SkyeLadderError::MathOverflow)?;

    // Find the applicable buy limit for this MC range
    let limit = match TIERS.iter().find(|(max_mc, _)| mc_usd < *max_mc) {
        Some((_, max_buy)) => *max_buy,
        None => return Ok(()), // Above $50K MC → no limit
    };

    // Reset accumulator if this is a new slot
    if current_slot != wallet.last_buy_slot {
        wallet.last_buy_slot = current_slot;
        wallet.slot_buy_usd = 0;
    }

    // Check: accumulated + this buy <= limit
    let new_total = (wallet.slot_buy_usd as u128)
        .checked_add(buy_usd as u128)
        .ok_or(SkyeLadderError::MathOverflow)?;

    require!(new_total <= limit, SkyeLadderError::BuyLimitExceeded);

    wallet.slot_buy_usd = new_total as u64;
    Ok(())
}

/// Compute the USD value of a token amount at the given SOL price.
/// Returns value scaled by USD_SCALE (10^6).
///
/// - `amount`: raw token amount
/// - `current_price`: SOL price per token, scaled by PRICE_SCALE (10^18)
/// - `sol_price_usd`: SOL/USD rate, scaled by USD_SCALE (10^6)
pub fn tokens_to_usd(amount: u64, current_price: u64, sol_price_usd: u64) -> Result<u64> {
    // value_sol_lamports = amount * price / PRICE_SCALE
    // value_usd = value_sol_lamports * sol_price_usd / LAMPORTS_PER_SOL
    let sol_lamports = (amount as u128)
        .checked_mul(current_price as u128)
        .ok_or(SkyeLadderError::MathOverflow)?
        .checked_div(PRICE_SCALE)
        .ok_or(SkyeLadderError::MathOverflow)?;
    let value = sol_lamports
        .checked_mul(sol_price_usd as u128)
        .ok_or(SkyeLadderError::MathOverflow)?
        .checked_div(LAMPORTS_PER_SOL)
        .ok_or(SkyeLadderError::MathOverflow)?;
    Ok(value as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::PRICE_SCALE;

    fn empty_wallet() -> WalletRecord {
        WalletRecord {
            owner: Pubkey::default(),
            mint: Pubkey::default(),
            position_count: 0,
            positions: vec![],
            last_buy_slot: 0,
            slot_buy_usd: 0,
            bump: 0,
        }
    }

    /// SOL price in USD for testing: $130 * USD_SCALE
    const SOL_PRICE: u64 = 130_000_000;

    /// Price (SOL-lamports per raw-token, scaled by PRICE_SCALE) for a given MC.
    /// mc = SUPPLY_RAW * price * sol_price / (PRICE_SCALE * LAMPORTS_PER_SOL)
    /// → price = mc * PRICE_SCALE * LAMPORTS_PER_SOL / (SUPPLY_RAW * sol_price)
    fn price_for_mc(mc_usd: f64) -> u64 {
        let mc_scaled = mc_usd * USD_SCALE as f64;
        (mc_scaled * PRICE_SCALE as f64 * LAMPORTS_PER_SOL as f64
            / (TOKEN_SUPPLY_RAW as f64 * SOL_PRICE as f64)) as u64
    }

    fn usd(amount: f64) -> u64 {
        (amount * USD_SCALE as f64) as u64
    }

    // ── Tier boundary tests ──

    #[test]
    fn test_under_5k_mc_100_limit() {
        let mut wallet = empty_wallet();
        let cp = price_for_mc(3_000.0); // $3K MC

        enforce_buy_limit(&mut wallet, usd(100.0), cp, SOL_PRICE, 1).unwrap();
        let result = enforce_buy_limit(&mut wallet, usd(1.0), cp, SOL_PRICE, 1);
        assert!(result.is_err());
    }

    #[test]
    fn test_5k_to_10k_mc_250_limit() {
        let mut wallet = empty_wallet();
        let cp = price_for_mc(7_000.0);

        enforce_buy_limit(&mut wallet, usd(250.0), cp, SOL_PRICE, 1).unwrap();
        let result = enforce_buy_limit(&mut wallet, usd(1.0), cp, SOL_PRICE, 1);
        assert!(result.is_err());
    }

    #[test]
    fn test_10k_to_25k_mc_500_limit() {
        let mut wallet = empty_wallet();
        let cp = price_for_mc(15_000.0);

        enforce_buy_limit(&mut wallet, usd(500.0), cp, SOL_PRICE, 1).unwrap();
        let result = enforce_buy_limit(&mut wallet, usd(1.0), cp, SOL_PRICE, 1);
        assert!(result.is_err());
    }

    #[test]
    fn test_25k_to_50k_mc_1000_limit() {
        let mut wallet = empty_wallet();
        let cp = price_for_mc(30_000.0);

        enforce_buy_limit(&mut wallet, usd(1_000.0), cp, SOL_PRICE, 1).unwrap();
        let result = enforce_buy_limit(&mut wallet, usd(1.0), cp, SOL_PRICE, 1);
        assert!(result.is_err());
    }

    #[test]
    fn test_above_50k_mc_no_limit() {
        let mut wallet = empty_wallet();
        let cp = price_for_mc(100_000.0);

        enforce_buy_limit(&mut wallet, usd(1_000_000.0), cp, SOL_PRICE, 1).unwrap();
    }

    #[test]
    fn test_zero_sol_price_skips_limits() {
        let mut wallet = empty_wallet();
        let cp = price_for_mc(3_000.0);

        // With sol_price_usd=0, any buy should pass
        enforce_buy_limit(&mut wallet, usd(999_999.0), cp, 0, 1).unwrap();
    }

    // ── Slot reset tests ──

    #[test]
    fn test_limit_resets_on_new_slot() {
        let mut wallet = empty_wallet();
        let cp = price_for_mc(3_000.0);

        enforce_buy_limit(&mut wallet, usd(100.0), cp, SOL_PRICE, 1).unwrap();
        let result = enforce_buy_limit(&mut wallet, usd(1.0), cp, SOL_PRICE, 1);
        assert!(result.is_err());

        enforce_buy_limit(&mut wallet, usd(100.0), cp, SOL_PRICE, 2).unwrap();
    }

    #[test]
    fn test_accumulates_within_same_slot() {
        let mut wallet = empty_wallet();
        let cp = price_for_mc(3_000.0);

        enforce_buy_limit(&mut wallet, usd(30.0), cp, SOL_PRICE, 1).unwrap();
        enforce_buy_limit(&mut wallet, usd(30.0), cp, SOL_PRICE, 1).unwrap();
        enforce_buy_limit(&mut wallet, usd(30.0), cp, SOL_PRICE, 1).unwrap();

        let result = enforce_buy_limit(&mut wallet, usd(11.0), cp, SOL_PRICE, 1);
        assert!(result.is_err());

        enforce_buy_limit(&mut wallet, usd(10.0), cp, SOL_PRICE, 1).unwrap();
    }

    // ── tokens_to_usd ──

    #[test]
    fn test_tokens_to_usd_conversion() {
        // 1M raw tokens at a price where MC=$3K at SOL=$130
        // MC=$3K means total supply (1B human = 10^18 raw) is worth $3K.
        // So 1M raw tokens (10^6) are worth $3K * 10^6 / 10^18 = $3 * 10^-9
        // That's too small. Let's use 1M human tokens = 10^15 raw instead.
        // 1M human tokens = 10^-3 of supply → $3K * 10^-3 = $3.
        let price_sol = price_for_mc(3_000.0);
        let amount_raw = 1_000_000u64 * 1_000_000_000; // 1M human tokens in raw
        let val = tokens_to_usd(amount_raw, price_sol, SOL_PRICE).unwrap();
        // Should be ~$3.00 = 3_000_000 in USD_SCALE (±10%)
        assert!(val >= 2_700_000 && val <= 3_300_000, "Got {}", val);
    }
}
