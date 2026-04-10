use anchor_lang::prelude::*;

use crate::errors::SkyeLadderError;
use crate::state::PRICE_SCALE;

// ═══════════════════════════════════════════════════════════════════════════════
// Supports BOTH Skye AMM Pool and Skye Curve account layouts.
//
// AMM Pool layout:
//   skye_amount at offset 200, wsol_amount at offset 208
//
// Curve layout:
//   virtual_token at offset 168, virtual_sol at offset 176
//
// We detect which layout by checking account size:
//   Curve accounts are exactly 284 bytes (< 300)
//   AMM Pool accounts are >= 300 bytes
// ═══════════════════════════════════════════════════════════════════════════════

/// Read the spot price from either a Skye AMM Pool or Skye Curve account.
/// Returns price scaled by PRICE_SCALE (10^18).
pub fn read_spot_price_from_pool(data: &[u8]) -> Result<u64> {
    // Determine account type by size:
    // - Curve accounts are exactly 284 bytes
    // - AMM Pool accounts are larger (>= 300 bytes typically)
    // Using size to disambiguate prevents reading wrong fields from a Curve
    // account at AMM offsets (200/208 overlap with total_supply/fee_bps).
    let is_curve = data.len() < 300 && data.len() >= 184;

    if is_curve {
        // Curve layout — virtual_token at 168, virtual_sol at 176
        let virtual_token = u64::from_le_bytes(
            data[168..176].try_into().map_err(|_| error!(SkyeLadderError::InvalidPool))?
        );
        let virtual_sol = u64::from_le_bytes(
            data[176..184].try_into().map_err(|_| error!(SkyeLadderError::InvalidPool))?
        );

        require!(virtual_token > 0, SkyeLadderError::ZeroPrice);
        require!(virtual_sol > 0, SkyeLadderError::ZeroPrice);

        let price = (virtual_sol as u128)
            .checked_mul(PRICE_SCALE)
            .ok_or(SkyeLadderError::MathOverflow)?
            .checked_div(virtual_token as u128)
            .ok_or(SkyeLadderError::ZeroPrice)?;
        return Ok(u64::try_from(price).map_err(|_| error!(SkyeLadderError::MathOverflow))?);
    }

    // Fallback: try AMM offsets directly
    require!(data.len() >= 216, SkyeLadderError::InvalidPool);

    let skye_amount = u64::from_le_bytes(
        data[200..208].try_into().map_err(|_| error!(SkyeLadderError::InvalidPool))?
    );
    let wsol_amount = u64::from_le_bytes(
        data[208..216].try_into().map_err(|_| error!(SkyeLadderError::InvalidPool))?
    );

    require!(skye_amount > 0, SkyeLadderError::ZeroPrice);
    require!(wsol_amount > 0, SkyeLadderError::ZeroPrice);

    let price = (wsol_amount as u128)
        .checked_mul(PRICE_SCALE)
        .ok_or(SkyeLadderError::MathOverflow)?
        .checked_div(skye_amount as u128)
        .ok_or(SkyeLadderError::ZeroPrice)?;

    Ok(u64::try_from(price).map_err(|_| error!(SkyeLadderError::MathOverflow))?)
}
