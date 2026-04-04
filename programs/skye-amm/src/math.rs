use crate::errors::SkyeAmmError;
use anchor_lang::prelude::*;

const BPS_DENOMINATOR: u128 = 10_000;

/// Compute swap output using constant product formula with fee.
/// amount_out = (amount_in_after_fee * reserve_out) / (reserve_in + amount_in_after_fee)
pub fn compute_swap_output(
    reserve_in: u64,
    reserve_out: u64,
    amount_in: u64,
    fee_bps: u16,
) -> Result<(u64, u64)> {
    require!(amount_in > 0, SkyeAmmError::ZeroAmount);
    require!(reserve_in > 0 && reserve_out > 0, SkyeAmmError::InsufficientLiquidity);

    let amount_in_128 = amount_in as u128;
    let fee = amount_in_128
        .checked_mul(fee_bps as u128)
        .ok_or(SkyeAmmError::MathOverflow)?
        / BPS_DENOMINATOR;
    let effective_in = amount_in_128
        .checked_sub(fee)
        .ok_or(SkyeAmmError::MathOverflow)?;

    let numerator = effective_in
        .checked_mul(reserve_out as u128)
        .ok_or(SkyeAmmError::MathOverflow)?;
    let denominator = (reserve_in as u128)
        .checked_add(effective_in)
        .ok_or(SkyeAmmError::MathOverflow)?;

    let amount_out = numerator / denominator;
    require!(amount_out > 0, SkyeAmmError::InsufficientLiquidity);
    require!(amount_out <= reserve_out as u128, SkyeAmmError::InsufficientLiquidity);

    Ok((amount_out as u64, fee as u64))
}

/// Compute initial LP tokens: sqrt(skye * wsol)
pub fn compute_initial_lp(skye: u64, wsol: u64) -> Result<u64> {
    require!(skye > 0 && wsol > 0, SkyeAmmError::ZeroAmount);
    let product = (skye as u128)
        .checked_mul(wsol as u128)
        .ok_or(SkyeAmmError::MathOverflow)?;
    Ok(integer_sqrt(product))
}

/// Compute proportional LP tokens for subsequent deposits.
/// lp = min(skye_deposit * total_lp / skye_reserve, wsol_deposit * total_lp / wsol_reserve)
pub fn compute_proportional_lp(
    skye_deposit: u64,
    wsol_deposit: u64,
    skye_reserve: u64,
    wsol_reserve: u64,
    total_lp: u64,
) -> Result<u64> {
    let lp_from_skye = (skye_deposit as u128)
        .checked_mul(total_lp as u128)
        .ok_or(SkyeAmmError::MathOverflow)?
        / (skye_reserve as u128);
    let lp_from_wsol = (wsol_deposit as u128)
        .checked_mul(total_lp as u128)
        .ok_or(SkyeAmmError::MathOverflow)?
        / (wsol_reserve as u128);
    Ok(lp_from_skye.min(lp_from_wsol) as u64)
}

/// Compute withdrawal amounts from LP burn.
pub fn compute_withdraw(
    lp_burn: u64,
    total_lp: u64,
    skye_reserve: u64,
    wsol_reserve: u64,
) -> Result<(u64, u64)> {
    require!(lp_burn > 0, SkyeAmmError::ZeroAmount);
    require!(lp_burn <= total_lp, SkyeAmmError::InsufficientLpTokens);

    let skye_out = (lp_burn as u128)
        .checked_mul(skye_reserve as u128)
        .ok_or(SkyeAmmError::MathOverflow)?
        / (total_lp as u128);
    let wsol_out = (lp_burn as u128)
        .checked_mul(wsol_reserve as u128)
        .ok_or(SkyeAmmError::MathOverflow)?
        / (total_lp as u128);

    Ok((skye_out as u64, wsol_out as u64))
}

/// Split fee: 50% team, 25% pool, 17.5% diamond, 7.5% strong.
/// Returns (team, pool, diamond, strong). Remainder goes to pool.
pub fn split_fee(fee: u64) -> (u64, u64, u64, u64) {
    let fee128 = fee as u128;
    let team = (fee128 / 2) as u64;                           // 50%
    let diamond = (fee128 * 175 / 1000) as u64;               // 17.5%
    let strong = (fee128 * 75 / 1000) as u64;                 // 7.5%
    let pool = fee - team - diamond - strong;                  // 25% + remainder
    (team, pool, diamond, strong)
}

/// Integer square root via Newton's method.
fn integer_sqrt(n: u128) -> u64 {
    if n == 0 {
        return 0;
    }
    let mut x = n;
    let mut y = (x + 1) / 2;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_swap_output() {
        // 1000 in, reserves 10000/10000, 1% fee
        let (out, fee) = compute_swap_output(10000, 10000, 1000, 100).unwrap();
        // effective_in = 1000 - 10 = 990
        // out = 990 * 10000 / (10000 + 990) = 9900000/10990 = 900
        assert_eq!(fee, 10);
        assert_eq!(out, 900);
    }

    #[test]
    fn test_initial_lp() {
        let lp = compute_initial_lp(1_000_000, 1_000_000).unwrap();
        assert_eq!(lp, 1_000_000);
    }

    #[test]
    fn test_fee_split() {
        let (team, pool, diamond, strong) = split_fee(1000);
        assert_eq!(team, 500);     // 50%
        assert_eq!(diamond, 175);  // 17.5%
        assert_eq!(strong, 75);    // 7.5%
        assert_eq!(pool, 250);     // 25%
        assert_eq!(team + pool + diamond + strong, 1000);
    }

    #[test]
    fn test_fee_split_small() {
        let (team, pool, diamond, strong) = split_fee(10);
        assert_eq!(team, 5);
        assert_eq!(diamond, 1);
        assert_eq!(strong, 0);
        // pool gets remainder
        assert_eq!(team + pool + diamond + strong, 10);
    }

    #[test]
    fn test_sqrt() {
        assert_eq!(integer_sqrt(0), 0);
        assert_eq!(integer_sqrt(1), 1);
        assert_eq!(integer_sqrt(4), 2);
        assert_eq!(integer_sqrt(100), 10);
        assert_eq!(integer_sqrt(1_000_000_000_000), 1_000_000);
    }
}
