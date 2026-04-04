use crate::errors::SkyeCurveError;
use anchor_lang::prelude::*;

/// Bonding curve math using virtual reserves (pump.fun style).
///
/// The curve uses constant product (x * y = k) with VIRTUAL reserves.
/// Virtual reserves include imaginary liquidity so the curve starts
/// at a predictable price without real liquidity.
///
/// price = virtual_sol / virtual_token
///
/// When buying: user sends SOL, receives tokens
///   tokens_out = virtual_token - (k / (virtual_sol + sol_in))
///              = sol_in * virtual_token / (virtual_sol + sol_in)
///
/// When selling: user sends tokens, receives SOL
///   sol_out = virtual_sol - (k / (virtual_token + tokens_in))
///           = tokens_in * virtual_sol / (virtual_token + tokens_in)

pub fn compute_buy(
    virtual_sol: u64,
    virtual_token: u64,
    sol_in: u64,
    fee_bps: u16,
) -> Result<(u64, u64)> {
    require!(sol_in > 0, SkyeCurveError::ZeroAmount);
    require!(virtual_sol > 0 && virtual_token > 0, SkyeCurveError::InsufficientLiquidity);

    let fee = (sol_in as u128) * (fee_bps as u128) / 10_000u128;
    let effective_in = (sol_in as u128) - fee;

    let tokens_out = effective_in
        .checked_mul(virtual_token as u128)
        .ok_or(SkyeCurveError::MathOverflow)?
        .checked_div(
            (virtual_sol as u128)
                .checked_add(effective_in)
                .ok_or(SkyeCurveError::MathOverflow)?,
        )
        .ok_or(SkyeCurveError::MathOverflow)?;

    require!(tokens_out > 0, SkyeCurveError::InsufficientLiquidity);

    Ok((tokens_out as u64, fee as u64))
}

pub fn compute_sell(
    virtual_sol: u64,
    virtual_token: u64,
    tokens_in: u64,
    fee_bps: u16,
) -> Result<(u64, u64)> {
    require!(tokens_in > 0, SkyeCurveError::ZeroAmount);
    require!(virtual_sol > 0 && virtual_token > 0, SkyeCurveError::InsufficientLiquidity);

    let sol_out_raw = (tokens_in as u128)
        .checked_mul(virtual_sol as u128)
        .ok_or(SkyeCurveError::MathOverflow)?
        .checked_div(
            (virtual_token as u128)
                .checked_add(tokens_in as u128)
                .ok_or(SkyeCurveError::MathOverflow)?,
        )
        .ok_or(SkyeCurveError::MathOverflow)?;

    let fee = sol_out_raw * (fee_bps as u128) / 10_000u128;
    let sol_out = sol_out_raw - fee;

    require!(sol_out > 0, SkyeCurveError::InsufficientLiquidity);

    Ok((sol_out as u64, fee as u64))
}

/// Compute initial virtual reserves for a target initial market cap.
///
/// initial_price = virtual_sol / virtual_token
/// market_cap = initial_price * total_supply = virtual_sol * total_supply / virtual_token
///
/// We set virtual_token = total_supply (all tokens in the curve).
/// Then virtual_sol = target_mc_lamports (the MC we want at launch).
///
/// Example: 1B tokens, $3K MC at $140 SOL = 21.4 SOL = 21_400_000_000 lamports
/// virtual_sol = 21_400_000_000, virtual_token = 1_000_000_000_000_000_000 (raw)
pub fn initial_virtual_reserves(
    total_supply_raw: u64,
    initial_virtual_sol: u64,
) -> (u64, u64) {
    (initial_virtual_sol, total_supply_raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_buy_basic() {
        // 30 SOL virtual, 1B tokens virtual, buy 1 SOL
        let (tokens, fee) = compute_buy(30_000_000_000, 1_000_000_000_000_000_000, 1_000_000_000, 100).unwrap();
        // effective = 0.99 SOL, tokens = 0.99 * 1B_raw / (30 + 0.99) ≈ 31.9M_raw ≈ 31.9 tokens
        assert!(tokens > 0);
        assert_eq!(fee, 10_000_000); // 1% of 1 SOL
    }

    #[test]
    fn test_sell_basic() {
        // Sell 1M tokens (1M * 10^9 raw)
        let (sol, fee) = compute_sell(30_000_000_000, 1_000_000_000_000_000_000, 1_000_000_000_000_000, 100).unwrap();
        assert!(sol > 0);
        assert!(fee > 0);
    }

    #[test]
    fn test_buy_sell_round_trip() {
        let vs = 30_000_000_000u64;
        let vt = 1_000_000_000_000_000_000u64;

        // Buy 1 SOL
        let (tokens_bought, _) = compute_buy(vs, vt, 1_000_000_000, 0).unwrap();
        // Sell those tokens back
        let new_vs = vs + 1_000_000_000;
        let new_vt = vt - tokens_bought;
        let (sol_back, _) = compute_sell(new_vs, new_vt, tokens_bought, 0).unwrap();

        // Should get back ~1 SOL (minus rounding)
        assert!(sol_back >= 999_999_000 && sol_back <= 1_000_000_001, "Got {}", sol_back);
    }

    #[test]
    fn test_price_increases_with_buys() {
        let vs = 30_000_000_000u64;
        let vt = 1_000_000_000_000_000_000u64;

        // Price before: vs / vt
        let price_before = vs as f64 / vt as f64;

        // Buy 5 SOL
        let (tokens, _) = compute_buy(vs, vt, 5_000_000_000, 0).unwrap();
        let new_vs = vs + 5_000_000_000;
        let new_vt = vt - tokens;

        // Price after
        let price_after = new_vs as f64 / new_vt as f64;

        assert!(price_after > price_before, "Price should increase after buy");
    }
}
