use anchor_lang::prelude::*;

use crate::errors::SkyeLadderError;
use crate::state::PRICE_SCALE;

// ═══════════════════════════════════════════════════════════════════════════════
// Skye AMM Pool account layout — byte offsets after 8-byte Anchor discriminator
//
// The Skye AMM stores cached reserve amounts directly in the Pool account,
// allowing us to compute the spot price with a simple read.
//
// Layout (Borsh-serialized):
//   authority       Pubkey   : [8..40]
//   skye_mint       Pubkey   : [40..72]
//   wsol_mint       Pubkey   : [72..104]
//   skye_reserve    Pubkey   : [104..136]
//   wsol_reserve    Pubkey   : [136..168]
//   lp_mint         Pubkey   : [168..200]
//   skye_amount     u64      : [200..208]
//   wsol_amount     u64      : [208..216]
//   fee_bps         u16      : [216..218]
//   bump            u8       : [218]
//   lp_authority_bump u8     : [219]
// ═══════════════════════════════════════════════════════════════════════════════

const SKYE_AMOUNT_OFFSET: usize = 200;
const WSOL_AMOUNT_OFFSET: usize = 208;

/// Minimum expected data length for a Pool account.
const MIN_POOL_LEN: usize = 220;

/// Read the spot price from the Skye AMM Pool account.
///
/// Returns the price of SKYE in WSOL units, scaled by PRICE_SCALE (10^18).
/// price = wsol_amount * PRICE_SCALE / skye_amount
///
/// Both tokens have 9 decimals, so raw amounts give a direct ratio.
pub fn read_spot_price_from_pool(pool_data: &[u8]) -> Result<u64> {
    require!(
        pool_data.len() >= MIN_POOL_LEN,
        SkyeLadderError::InvalidPool
    );

    let skye_amount = u64::from_le_bytes(
        pool_data[SKYE_AMOUNT_OFFSET..SKYE_AMOUNT_OFFSET + 8]
            .try_into()
            .map_err(|_| error!(SkyeLadderError::InvalidPool))?,
    );
    let wsol_amount = u64::from_le_bytes(
        pool_data[WSOL_AMOUNT_OFFSET..WSOL_AMOUNT_OFFSET + 8]
            .try_into()
            .map_err(|_| error!(SkyeLadderError::InvalidPool))?,
    );

    require!(skye_amount > 0, SkyeLadderError::ZeroPrice);
    require!(wsol_amount > 0, SkyeLadderError::ZeroPrice);

    // price = wsol_amount * PRICE_SCALE / skye_amount
    let price = (wsol_amount as u128)
        .checked_mul(PRICE_SCALE)
        .ok_or(SkyeLadderError::MathOverflow)?
        .checked_div(skye_amount as u128)
        .ok_or(SkyeLadderError::ZeroPrice)?;

    require!(price > 0, SkyeLadderError::ZeroPrice);
    Ok(price as u64)
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    fn make_pool_data(skye_amount: u64, wsol_amount: u64) -> Vec<u8> {
        let mut data = vec![0u8; MIN_POOL_LEN];
        data[SKYE_AMOUNT_OFFSET..SKYE_AMOUNT_OFFSET + 8]
            .copy_from_slice(&skye_amount.to_le_bytes());
        data[WSOL_AMOUNT_OFFSET..WSOL_AMOUNT_OFFSET + 8]
            .copy_from_slice(&wsol_amount.to_le_bytes());
        data
    }

    #[test]
    fn test_price_equal_reserves() {
        let data = make_pool_data(1_000_000_000, 1_000_000_000);
        let price = read_spot_price_from_pool(&data).unwrap();
        assert_eq!(price, PRICE_SCALE as u64); // 1.0
    }

    #[test]
    fn test_price_skye_cheaper() {
        // 1B SKYE, 0.1 SOL -> price = 0.1/1B * 10^18 = 10^8
        let data = make_pool_data(1_000_000_000_000_000_000, 100_000_000);
        let price = read_spot_price_from_pool(&data).unwrap();
        // Very small price
        assert!(price > 0);
        assert!(price < PRICE_SCALE as u64);
    }

    #[test]
    fn test_price_rejects_zero_skye() {
        let data = make_pool_data(0, 1_000_000);
        assert!(read_spot_price_from_pool(&data).is_err());
    }

    #[test]
    fn test_price_rejects_zero_wsol() {
        let data = make_pool_data(1_000_000, 0);
        assert!(read_spot_price_from_pool(&data).is_err());
    }

    #[test]
    fn test_price_rejects_short_data() {
        let data = vec![0u8; 50];
        assert!(read_spot_price_from_pool(&data).is_err());
    }

    #[test]
    fn test_price_at_launch_mc() {
        // Simulate launch: 1B SKYE (9 dec) vs ~0.023 SOL (9 dec) for ~$3K MC at SOL=$130
        let skye = 1_000_000_000u64 * 1_000_000_000; // 1B * 10^9
        let wsol = 23_000_000u64; // 0.023 SOL * 10^9
        let data = make_pool_data(skye, wsol);
        let price = read_spot_price_from_pool(&data).unwrap();
        // price = 0.023 * 10^18 / 10^18 = 2.3 * 10^-8 * 10^18 = 2.3 * 10^10
        assert!(price > 0);
        assert!(price < PRICE_SCALE as u64); // < 1.0 (SKYE is very cheap)
    }
}
