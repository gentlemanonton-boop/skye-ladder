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

    Ok((
        u64::try_from(tokens_out).map_err(|_| error!(SkyeCurveError::MathOverflow))?,
        u64::try_from(fee).map_err(|_| error!(SkyeCurveError::MathOverflow))?,
    ))
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

    Ok((
        u64::try_from(sol_out).map_err(|_| error!(SkyeCurveError::MathOverflow))?,
        u64::try_from(fee).map_err(|_| error!(SkyeCurveError::MathOverflow))?,
    ))
}

/// Apply the 50/50 treasury/pool split to a sell output.
///
/// Given the values returned from `compute_sell`:
///   - `sol_out` = `sol_out_raw - fee` (already net of the FULL fee)
///   - `fee`     = the fee that was deducted from `sol_out_raw`
///
/// Returns `(user_amount, treasury_amount, reserve_decrement)` where:
///   - `user_amount`       = what the seller receives (the FULL `sol_out`)
///   - `treasury_amount`   = `fee / 2` (the treasury's half of the fee)
///   - `reserve_decrement` = `user_amount + treasury_amount` (what actually
///                            leaves the curve's `sol_reserve` ATA)
///
/// The remaining `fee - treasury_amount = fee/2` stays inside the curve
/// reserves — that is the "pool's half" of the fee. This is what the comment
/// `// Treasury takes 50% of the fee` in `swap.rs` was always meant to do.
///
/// HISTORY: an earlier version of `swap.rs` mistakenly subtracted
/// `treasury_fee` from `sol_out` directly, which charged sellers ~1.5×
/// `fee_bps` instead of `fee_bps`. This helper exists so the splitting policy
/// is captured in one testable place and can never silently drift again.
pub fn split_sell_output(sol_out: u64, fee: u64) -> Result<(u64, u64, u64)> {
    let treasury_amount = fee / 2;
    let user_amount = sol_out;
    let reserve_decrement = user_amount
        .checked_add(treasury_amount)
        .ok_or(SkyeCurveError::MathOverflow)?;
    Ok((user_amount, treasury_amount, reserve_decrement))
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

    // ── split_sell_output (treasury/pool fee split) ──────────────────────
    //
    // These tests pin the on-chain user-receive formula for sells.
    // If anyone changes the splitting policy in `swap.rs`, these tests
    // will fail loudly. The frontend's `computeCurveSellOutput` mirrors
    // the same formula and must be updated in lockstep.

    #[test]
    fn test_split_sell_output_basic_1pct_fee() {
        // 1 SOL gross output, 1% fee → fee = 0.01 SOL, treasury gets 0.005,
        // user gets the full 0.99 SOL back, reserves drop by 0.995.
        let sol_out_raw = 1_000_000_000u64; // 1 SOL
        let fee = sol_out_raw * 100 / 10_000; // 1% = 10_000_000
        let sol_out = sol_out_raw - fee;       // 990_000_000
        let (user, treasury, decrement) = split_sell_output(sol_out, fee).unwrap();
        assert_eq!(user, 990_000_000, "user receives full sol_out (no double fee)");
        assert_eq!(treasury, 5_000_000, "treasury gets fee/2");
        assert_eq!(decrement, 995_000_000, "reserves drop by user + treasury");
        // Pool retains the other fee/2:
        assert_eq!(sol_out_raw - decrement, 5_000_000);
    }

    #[test]
    fn test_split_sell_output_user_pays_exactly_fee_bps() {
        // Confirm user pays exactly fee_bps (1%), NOT 1.5%.
        // sol_out_raw - user_amount should equal `fee` (the full 1%).
        let sol_out_raw = 30_000_000_000u64; // 30 SOL
        let fee = sol_out_raw * 100 / 10_000; // 1% = 300_000_000
        let sol_out = sol_out_raw - fee;
        let (user, _, _) = split_sell_output(sol_out, fee).unwrap();
        let user_loss = sol_out_raw - user;
        assert_eq!(user_loss, fee, "user pays exactly fee_bps, not 1.5×");
    }

    #[test]
    fn test_split_sell_output_zero_fee() {
        // No fee → user gets everything, treasury gets nothing.
        let (user, treasury, decrement) = split_sell_output(1_000_000_000, 0).unwrap();
        assert_eq!(user, 1_000_000_000);
        assert_eq!(treasury, 0);
        assert_eq!(decrement, 1_000_000_000);
    }

    #[test]
    fn test_split_sell_output_odd_fee_rounds_down() {
        // Odd fee → integer division floors, treasury gets one less than half.
        let sol_out = 999u64;
        let fee = 7u64;
        let (user, treasury, decrement) = split_sell_output(sol_out, fee).unwrap();
        assert_eq!(user, 999);
        assert_eq!(treasury, 3); // 7 / 2 = 3, not 3.5
        assert_eq!(decrement, 1002);
    }

    #[test]
    fn test_split_sell_output_full_pipeline_via_compute_sell() {
        // End-to-end: run compute_sell, then split, and verify the user
        // receives exactly fee_bps less than sol_out_raw (computed manually).
        let v_sol = 30_000_000_000u64;
        let v_token = 1_000_000_000_000_000_000u64;
        let tokens_in = 1_000_000_000_000_000u64; // 1M whole tokens

        // Manual sol_out_raw (no fee)
        let sol_out_raw_manual = (tokens_in as u128) * (v_sol as u128)
            / ((v_token as u128) + (tokens_in as u128));

        let (sol_out, fee) = compute_sell(v_sol, v_token, tokens_in, 100).unwrap();
        let (user, treasury, decrement) = split_sell_output(sol_out, fee).unwrap();

        // User loses exactly fee (= 1% of raw), not 1.5×
        assert_eq!(sol_out_raw_manual as u64 - user, fee);
        // Reserves drop by raw - fee/2
        assert_eq!(sol_out_raw_manual as u64 - decrement, fee / 2);
        // Treasury gets fee/2
        assert_eq!(treasury, fee / 2);
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
