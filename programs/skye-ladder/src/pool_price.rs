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
//   AMM Pool >= 220 bytes, Curve >= 184 bytes but < 220 OR try both
// ═══════════════════════════════════════════════════════════════════════════════

/// Read the spot price from either a Skye AMM Pool or Skye Curve account.
/// Returns price scaled by PRICE_SCALE (10^18).
pub fn read_spot_price_from_pool(data: &[u8]) -> Result<u64> {
    // Try Curve offsets first (168/176) — works for bonding curve
    if data.len() >= 184 {
        let token_at_168 = u64::from_le_bytes(
            data[168..176].try_into().map_err(|_| error!(SkyeLadderError::InvalidPool))?
        );
        let sol_at_176 = u64::from_le_bytes(
            data[176..184].try_into().map_err(|_| error!(SkyeLadderError::InvalidPool))?
        );

        // If both are reasonable values (> 0 and < u64::MAX/2), use curve offsets
        if token_at_168 > 0 && sol_at_176 > 0
            && token_at_168 < u64::MAX / 2 && sol_at_176 < u64::MAX / 2
        {
            // Also check AMM offsets — if AMM offsets give valid values too,
            // prefer AMM (it has the real cached amounts after flush)
            if data.len() >= 216 {
                let token_at_200 = u64::from_le_bytes(
                    data[200..208].try_into().map_err(|_| error!(SkyeLadderError::InvalidPool))?
                );
                let sol_at_208 = u64::from_le_bytes(
                    data[208..216].try_into().map_err(|_| error!(SkyeLadderError::InvalidPool))?
                );
                if token_at_200 > 0 && sol_at_208 > 0
                    && token_at_200 < u64::MAX / 2 && sol_at_208 < u64::MAX / 2
                {
                    // AMM layout — use offsets 200/208
                    let price = (sol_at_208 as u128)
                        .checked_mul(PRICE_SCALE)
                        .ok_or(SkyeLadderError::MathOverflow)?
                        .checked_div(token_at_200 as u128)
                        .ok_or(SkyeLadderError::ZeroPrice)?;
                    return Ok(price as u64);
                }
            }

            // Curve layout — use offsets 168/176
            let price = (sol_at_176 as u128)
                .checked_mul(PRICE_SCALE)
                .ok_or(SkyeLadderError::MathOverflow)?
                .checked_div(token_at_168 as u128)
                .ok_or(SkyeLadderError::ZeroPrice)?;
            return Ok(price as u64);
        }
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

    Ok(price as u64)
}
