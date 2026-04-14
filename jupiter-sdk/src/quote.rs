//! Quoting logic — must exactly mirror on-chain `skye_amm::math`.

const BPS_DENOMINATOR: u128 = 10_000;

/// Constant-product swap with input-side fee.
/// Returns `(amount_out, fee)`.
///
/// Mirrors `programs/skye-amm/src/math.rs::compute_swap_output` exactly.
pub fn compute_swap_output(
    reserve_in: u64,
    reserve_out: u64,
    amount_in: u64,
    fee_bps: u16,
) -> Option<(u64, u64)> {
    if amount_in == 0 || reserve_in == 0 || reserve_out == 0 {
        return None;
    }

    let amount_in_128 = amount_in as u128;
    let fee = amount_in_128
        .checked_mul(fee_bps as u128)?
        / BPS_DENOMINATOR;
    let effective_in = amount_in_128.checked_sub(fee)?;

    let numerator = effective_in.checked_mul(reserve_out as u128)?;
    let denominator = (reserve_in as u128).checked_add(effective_in)?;

    let amount_out = numerator / denominator;
    if amount_out == 0 || amount_out > reserve_out as u128 {
        return None;
    }

    Some((amount_out as u64, fee as u64))
}

/// Split fee 50/50 — team / pool. Mirrors on-chain `math::split_fee`.
pub fn split_fee(fee: u64) -> (u64, u64) {
    let team = fee / 2;
    let pool = fee - team;
    (team, pool)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_matches_onchain() {
        // Same test case from programs/skye-amm/src/math.rs
        let (out, fee) = compute_swap_output(10_000, 10_000, 1_000, 100).unwrap();
        assert_eq!(fee, 10);
        assert_eq!(out, 900);
    }

    #[test]
    fn test_zero_input() {
        assert!(compute_swap_output(10_000, 10_000, 0, 100).is_none());
    }

    #[test]
    fn test_zero_reserves() {
        assert!(compute_swap_output(0, 10_000, 1_000, 100).is_none());
        assert!(compute_swap_output(10_000, 0, 1_000, 100).is_none());
    }

    #[test]
    fn test_fee_split() {
        assert_eq!(split_fee(1000), (500, 500));
        assert_eq!(split_fee(11), (5, 6));
        assert_eq!(split_fee(0), (0, 0));
    }
}
