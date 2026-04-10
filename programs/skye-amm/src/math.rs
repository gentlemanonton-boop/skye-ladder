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

    Ok((
        u64::try_from(amount_out).map_err(|_| error!(SkyeAmmError::MathOverflow))?,
        u64::try_from(fee).map_err(|_| error!(SkyeAmmError::MathOverflow))?,
    ))
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
    Ok(u64::try_from(lp_from_skye.min(lp_from_wsol)).map_err(|_| error!(SkyeAmmError::MathOverflow))?)
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

    Ok((
        u64::try_from(skye_out).map_err(|_| error!(SkyeAmmError::MathOverflow))?,
        u64::try_from(wsol_out).map_err(|_| error!(SkyeAmmError::MathOverflow))?,
    ))
}

/// Split a swap fee 50/50 between the protocol team and the LP pool.
///
/// - **team** = 50% → goes to the treasury WSOL ATA configured via
///   `set_fee_config`. This is the protocol/team's withdrawable revenue.
/// - **pool** = 50% → stays inside the pool reserves, compounding into the
///   constant-product LP for the benefit of liquidity providers.
///
/// The previous implementation split fees four ways (team / pool / diamond /
/// strong) to feed `claim_rewards` style holder incentives. That model was
/// scrapped — diamond/strong vaults no longer exist.
pub fn split_fee(fee: u64) -> (u64, u64) {
    let team = fee / 2;       // 50% to treasury
    let pool = fee - team;    // 50% to LP (handles odd-lamport remainder)
    (team, pool)
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
    fn test_fee_split_50_50() {
        let (team, pool) = split_fee(1000);
        assert_eq!(team, 500);
        assert_eq!(pool, 500);
        assert_eq!(team + pool, 1000);
    }

    #[test]
    fn test_fee_split_odd_remainder() {
        // Odd fee → integer division floors team, pool gets the extra lamport.
        let (team, pool) = split_fee(11);
        assert_eq!(team, 5);
        assert_eq!(pool, 6);
        assert_eq!(team + pool, 11);
    }

    #[test]
    fn test_fee_split_zero() {
        let (team, pool) = split_fee(0);
        assert_eq!(team, 0);
        assert_eq!(pool, 0);
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
