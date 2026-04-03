use crate::errors::SkyeLadderError;
use crate::math;
use crate::state::{
    Position, WalletRecord, MAX_POSITIONS, MERGE_THRESHOLD_BPS, PRICE_SCALE,
};
use anchor_lang::prelude::*;

// ═══════════════════════════════════════════════════════════════════════════════
// Buy: create or merge a new position
// ═══════════════════════════════════════════════════════════════════════════════

/// Record a buy: creates a new position or merges into an existing one
/// if the entry prices are within 10% of each other.
///
/// - `tokens_bought`: raw token amount received
/// - `current_price`: spot price scaled by PRICE_SCALE (10^18)
pub fn on_buy(
    wallet: &mut WalletRecord,
    tokens_bought: u64,
    current_price: u64,
) -> Result<()> {
    require!(current_price > 0, SkyeLadderError::ZeroPrice);
    require!(tokens_bought > 0, SkyeLadderError::ZeroTokens);

    // initial_sol = tokens_bought * current_price / PRICE_SCALE
    let initial_sol = (tokens_bought as u128)
        .checked_mul(current_price as u128)
        .ok_or(SkyeLadderError::MathOverflow)?
        .checked_div(PRICE_SCALE)
        .ok_or(SkyeLadderError::MathOverflow)? as u64;

    // Try to merge with an existing position within 10% of current_price
    if let Some(merge_idx) = find_mergeable_position(&wallet.positions, current_price) {
        merge_into_position(
            &mut wallet.positions[merge_idx],
            tokens_bought,
            current_price,
            initial_sol,
        )?;
        return Ok(());
    }

    // No merge candidate — need a new slot
    if wallet.positions.len() >= MAX_POSITIONS {
        // Force-merge the two closest positions to make room
        merge_closest_pair(&mut wallet.positions)?;
    }

    wallet.positions.push(Position {
        entry_price: current_price,
        initial_sol,
        token_balance: tokens_bought,
        unlocked_bps: 0,
        original_balance: tokens_bought,
    });
    wallet.position_count = wallet.positions.len() as u8;

    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════════
// Sell: enforce unlock, deduct from highest multiplier first
// ═══════════════════════════════════════════════════════════════════════════════

/// Enforce the sell restriction across all positions. Sells from the highest
/// multiplier (most-unlocked) positions first. Reverts if the total sellable
/// tokens are insufficient.
///
/// Uses a two-phase approach: first compute deductions without mutating,
/// then apply only if the total is sufficient. This prevents corrupted state
/// on revert.
///
/// Returns Ok(()) if the sell is allowed, updating position balances in place.
pub fn on_sell(
    wallet: &mut WalletRecord,
    tokens_to_sell: u64,
    current_price: u64,
) -> Result<()> {
    require!(current_price > 0, SkyeLadderError::ZeroPrice);
    require!(tokens_to_sell > 0, SkyeLadderError::ZeroTokens);

    // Build index + multiplier pairs, sorted by multiplier descending
    let mut indexed: Vec<(usize, u128)> = wallet
        .positions
        .iter()
        .enumerate()
        .map(|(i, pos)| {
            let mult = if pos.entry_price == 0 {
                0u128
            } else {
                (current_price as u128) * 10_000 / (pos.entry_price as u128)
            };
            (i, mult)
        })
        .collect();

    // Sort by multiplier descending (sell most-unlocked first)
    indexed.sort_by(|a, b| b.1.cmp(&a.1));

    // ── Phase 1: Compute deductions on clones (no mutation) ──
    let mut deductions: Vec<(usize, u64, u32)> = Vec::new(); // (index, tokens_to_take, new_bps)
    let mut remaining = tokens_to_sell;

    for (idx, _mult) in &indexed {
        if remaining == 0 {
            break;
        }

        let pos = &wallet.positions[*idx];
        if pos.is_empty() {
            continue;
        }

        // Calculate effective unlock on a clone (don't mutate the original yet)
        let mut pos_clone = *pos;
        let (sellable, bps) = math::sellable_tokens(current_price, &mut pos_clone)?;

        let take = sellable.min(remaining);
        if take > 0 {
            deductions.push((*idx, take, bps));
            remaining -= take;
        }
    }

    // If we couldn't sell enough, fail WITHOUT having mutated anything
    require!(remaining == 0, SkyeLadderError::SellExceedsUnlocked);

    // ── Phase 2: Apply deductions (we know the sell is valid) ──
    for (idx, take, bps) in &deductions {
        let pos = &mut wallet.positions[*idx];
        pos.unlocked_bps = *bps; // Apply high-water mark
        pos.token_balance = pos
            .token_balance
            .checked_sub(*take)
            .ok_or(SkyeLadderError::MathOverflow)?;
    }

    // Clean up empty positions
    wallet.positions.retain(|p| !p.is_empty());
    wallet.position_count = wallet.positions.len() as u8;

    // Merge any Phase 5 (15x+) positions together
    consolidate_fully_unlocked(&mut wallet.positions, current_price);
    wallet.position_count = wallet.positions.len() as u8;

    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════════
// Merge helpers
// ═══════════════════════════════════════════════════════════════════════════════

/// Find the first position whose entry_price is within 10% of `price`.
fn find_mergeable_position(positions: &[Position], price: u64) -> Option<usize> {
    let price_128 = price as u128;
    let threshold = MERGE_THRESHOLD_BPS as u128; // 1000 = 10%
    let denom = 10_000u128;

    positions.iter().position(|pos| {
        if pos.is_empty() {
            return false;
        }
        let ep = pos.entry_price as u128;
        // |entry_price - price| / entry_price < 10%
        // ⟹ |entry_price - price| * 10000 < entry_price * 1000
        let diff = if ep > price_128 {
            ep - price_128
        } else {
            price_128 - ep
        };
        diff * denom < ep * threshold
    })
}

/// Merge a new buy into an existing position using weighted average entry price.
fn merge_into_position(
    existing: &mut Position,
    tokens_bought: u64,
    _current_price: u64,
    new_initial_sol: u64,
) -> Result<()> {
    let old_cost = existing.initial_sol as u128;
    let new_cost = new_initial_sol as u128;
    let total_cost = old_cost
        .checked_add(new_cost)
        .ok_or(SkyeLadderError::MathOverflow)?;

    let old_tokens = existing.token_balance as u128;
    let new_tokens = tokens_bought as u128;
    let total_tokens = old_tokens
        .checked_add(new_tokens)
        .ok_or(SkyeLadderError::MathOverflow)?;

    // Weighted average entry price = total_cost * PRICE_SCALE / total_tokens
    let new_entry = total_cost
        .checked_mul(PRICE_SCALE)
        .ok_or(SkyeLadderError::MathOverflow)?
        .checked_div(total_tokens)
        .ok_or(SkyeLadderError::MathOverflow)?;

    existing.entry_price = new_entry as u64;
    existing.initial_sol = total_cost as u64;
    existing.token_balance = total_tokens as u64;
    // Merge original_balance: sum of both originals (new buy's original = tokens_bought)
    let old_original = if existing.original_balance > 0 {
        existing.original_balance as u128
    } else {
        old_tokens // legacy fallback
    };
    existing.original_balance = old_original
        .checked_add(new_tokens)
        .ok_or(SkyeLadderError::MathOverflow)? as u64;
    // Keep the higher unlocked_bps (conservative for the holder)
    // New buy starts at 0, so existing.unlocked_bps is always >= 0

    Ok(())
}

/// Find and merge the two positions with the closest entry prices.
/// Called when the position cap (10) is hit.
fn merge_closest_pair(positions: &mut Vec<Position>) -> Result<()> {
    if positions.len() < 2 {
        return Ok(());
    }

    let mut min_diff = u128::MAX;
    let mut merge_a = 0usize;
    let mut merge_b = 1usize;

    for i in 0..positions.len() {
        for j in (i + 1)..positions.len() {
            let a = positions[i].entry_price as u128;
            let b = positions[j].entry_price as u128;
            let diff = if a > b { a - b } else { b - a };
            if diff < min_diff {
                min_diff = diff;
                merge_a = i;
                merge_b = j;
            }
        }
    }

    // Merge b into a
    let pos_b = positions[merge_b];

    let total_cost = (positions[merge_a].initial_sol as u128)
        .checked_add(pos_b.initial_sol as u128)
        .ok_or(SkyeLadderError::MathOverflow)?;
    let total_tokens = (positions[merge_a].token_balance as u128)
        .checked_add(pos_b.token_balance as u128)
        .ok_or(SkyeLadderError::MathOverflow)?;

    let new_entry = total_cost
        .checked_mul(PRICE_SCALE)
        .ok_or(SkyeLadderError::MathOverflow)?
        .checked_div(total_tokens)
        .ok_or(SkyeLadderError::MathOverflow)?;

    positions[merge_a].entry_price = new_entry as u64;
    positions[merge_a].initial_sol = total_cost as u64;
    positions[merge_a].token_balance = total_tokens as u64;
    // Sum original_balances
    let orig_a = if positions[merge_a].original_balance > 0 {
        positions[merge_a].original_balance as u128
    } else {
        positions[merge_a].token_balance as u128
    };
    let orig_b = if pos_b.original_balance > 0 {
        pos_b.original_balance as u128
    } else {
        pos_b.token_balance as u128
    };
    positions[merge_a].original_balance = orig_a.saturating_add(orig_b) as u64;
    // Keep the higher unlocked_bps of the two
    positions[merge_a].unlocked_bps =
        positions[merge_a].unlocked_bps.max(pos_b.unlocked_bps);

    positions.remove(merge_b);
    Ok(())
}

/// Consolidate all positions at 15x+ (fully unlocked) into a single position.
fn consolidate_fully_unlocked(positions: &mut Vec<Position>, current_price: u64) {
    let cp = current_price as u128;

    // Find all positions at 15x+
    let fully_unlocked: Vec<usize> = positions
        .iter()
        .enumerate()
        .filter(|(_, pos)| {
            if pos.entry_price == 0 || pos.is_empty() {
                return false;
            }
            let mult = cp * 10_000 / (pos.entry_price as u128);
            mult >= 150_000 // 15x
        })
        .map(|(i, _)| i)
        .collect();

    if fully_unlocked.len() <= 1 {
        return;
    }

    // Merge all into the first one
    let first = fully_unlocked[0];
    let mut total_sol = positions[first].initial_sol as u128;
    let mut total_tokens = positions[first].token_balance as u128;
    let mut total_original = positions[first].original_balance.max(positions[first].token_balance) as u128;

    for &idx in fully_unlocked.iter().skip(1) {
        total_sol += positions[idx].initial_sol as u128;
        total_tokens += positions[idx].token_balance as u128;
        total_original += positions[idx].original_balance.max(positions[idx].token_balance) as u128;
    }

    // Use current_price as entry for the consolidated position (it's fully unlocked anyway)
    positions[first].entry_price = current_price;
    positions[first].initial_sol = total_sol as u64;
    positions[first].token_balance = total_tokens as u64;
    positions[first].original_balance = total_original as u64;
    positions[first].unlocked_bps = 10_000;

    // Remove the others (in reverse order to preserve indices)
    for &idx in fully_unlocked.iter().skip(1).rev() {
        positions.remove(idx);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

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

    fn price(usd: f64) -> u64 {
        (usd * PRICE_SCALE as f64) as u64
    }

    // ── Buy tests ──

    #[test]
    fn test_buy_creates_position() {
        let mut wallet = empty_wallet();
        let cp = price(0.000003);
        on_buy(&mut wallet, 1_000_000_000, cp).unwrap();

        assert_eq!(wallet.positions.len(), 1);
        assert_eq!(wallet.position_count, 1);
        assert_eq!(wallet.positions[0].token_balance, 1_000_000_000);
        assert_eq!(wallet.positions[0].entry_price, cp);
        assert_eq!(wallet.positions[0].unlocked_bps, 0);
    }

    #[test]
    fn test_buy_merges_within_10_percent() {
        let mut wallet = empty_wallet();
        let cp1 = price(0.000003);
        on_buy(&mut wallet, 1_000_000_000, cp1).unwrap();

        // Second buy at 5% higher — within 10% threshold
        let cp2 = price(0.00000315);
        on_buy(&mut wallet, 500_000_000, cp2).unwrap();

        // Should have merged into one position
        assert_eq!(wallet.positions.len(), 1);
        assert_eq!(wallet.positions[0].token_balance, 1_500_000_000);
    }

    #[test]
    fn test_buy_separate_when_outside_10_percent() {
        let mut wallet = empty_wallet();
        let cp1 = price(0.000003);
        on_buy(&mut wallet, 1_000_000_000, cp1).unwrap();

        // Second buy at 20% higher — outside threshold
        let cp2 = price(0.0000036);
        on_buy(&mut wallet, 500_000_000, cp2).unwrap();

        assert_eq!(wallet.positions.len(), 2);
        assert_eq!(wallet.position_count, 2);
    }

    #[test]
    fn test_buy_force_merges_at_cap() {
        let mut wallet = empty_wallet();

        // Fill 10 positions at widely spaced prices
        for i in 0..10 {
            let cp = price(0.00001 * (i as f64 + 1.0));
            on_buy(&mut wallet, 100_000_000, cp).unwrap();
        }
        assert_eq!(wallet.positions.len(), 10);

        // 11th buy should force-merge two closest, then add
        let cp = price(0.0001);
        on_buy(&mut wallet, 100_000_000, cp).unwrap();

        // After force-merge + add, should still be <= 10
        assert!(wallet.positions.len() <= 10);
    }

    // ── Sell tests ──

    #[test]
    fn test_sell_underwater_allows_full() {
        let mut wallet = empty_wallet();
        let entry = price(0.000003);
        on_buy(&mut wallet, 1_000_000_000, entry).unwrap();

        // Price drops to 0.5x
        let cp = price(0.0000015);
        on_sell(&mut wallet, 1_000_000_000, cp).unwrap();

        // All sold, position cleaned up
        assert_eq!(wallet.positions.len(), 0);
    }

    #[test]
    fn test_sell_at_5x_allows_62_5_percent() {
        let mut wallet = empty_wallet();
        let entry = price(0.000003);
        on_buy(&mut wallet, 1_000_000_000, entry).unwrap();

        let cp = price(0.000015); // 5x
        // 62.5% of 1B = 625M should be sellable
        on_sell(&mut wallet, 625_000_000, cp).unwrap();

        assert_eq!(wallet.positions[0].token_balance, 375_000_000);
    }

    #[test]
    fn test_sell_exceeds_unlock_reverts() {
        let mut wallet = empty_wallet();
        let entry = price(0.000003);
        on_buy(&mut wallet, 1_000_000_000, entry).unwrap();

        let cp = price(0.000015); // 5x → 62.5% = 625M sellable
        let result = on_sell(&mut wallet, 626_000_000, cp);
        assert!(result.is_err());
    }

    #[test]
    fn test_sell_highest_mult_first() {
        let mut wallet = empty_wallet();

        // Position A: entry at 0.000003 (low entry = high mult at current price)
        on_buy(&mut wallet, 500_000_000, price(0.000003)).unwrap();
        // Position B: entry at 0.00003 (high entry = lower mult at current price)
        on_buy(&mut wallet, 500_000_000, price(0.00003)).unwrap();

        // Current price at 0.00015 → Position A at 50x (fully unlocked), B at 5x (62.5%)
        let cp = price(0.00015);
        // Sell 500M — should drain all of Position A first (it's fully unlocked at 50x)
        on_sell(&mut wallet, 500_000_000, cp).unwrap();

        // Position A should be empty, Position B untouched
        assert_eq!(wallet.positions.len(), 1);
        assert_eq!(wallet.positions[0].token_balance, 500_000_000);
        assert_eq!(wallet.positions[0].entry_price, price(0.00003));
    }

    #[test]
    fn test_sell_across_multiple_positions() {
        let mut wallet = empty_wallet();

        on_buy(&mut wallet, 500_000_000, price(0.000003)).unwrap();
        on_buy(&mut wallet, 500_000_000, price(0.00003)).unwrap();

        // At 0.00015: A is 50x (100%), B is 5x (62.5% = 312.5M sellable)
        let cp = price(0.00015);
        // Sell 700M — needs 500M from A + 200M from B
        on_sell(&mut wallet, 700_000_000, cp).unwrap();

        // Position A gone, Position B partially sold
        assert_eq!(wallet.positions.len(), 1);
        assert_eq!(wallet.positions[0].token_balance, 300_000_000);
    }

    #[test]
    fn test_high_water_mark_persists_through_sell() {
        let mut wallet = empty_wallet();
        let entry = price(0.000003);
        on_buy(&mut wallet, 1_000_000_000, entry).unwrap();

        // Price at 10x → 75% unlock → max sellable = 750M from original 1B
        let cp_10x = price(0.00003);
        on_sell(&mut wallet, 100_000_000, cp_10x).unwrap();

        // High-water mark should be 7500
        assert_eq!(wallet.positions[0].unlocked_bps, 7_500);

        // Price drops to 3x — high-water keeps 75%
        // Already sold 100M of 750M allowed. 650M still sellable.
        let cp_3x = price(0.000009);
        on_sell(&mut wallet, 650_000_000, cp_3x).unwrap();

        // Should succeed — total sold = 100M + 650M = 750M = exactly 75% of 1B
        assert_eq!(wallet.positions[0].token_balance, 250_000_000);
    }

    // ── Phase 5 consolidation ──

    #[test]
    fn test_consolidate_fully_unlocked_positions() {
        let mut wallet = empty_wallet();

        // Two positions both at 15x+
        on_buy(&mut wallet, 300_000_000, price(0.000001)).unwrap();
        on_buy(&mut wallet, 200_000_000, price(0.000002)).unwrap();

        assert_eq!(wallet.positions.len(), 2);

        // At price 0.0001 → position A is 100x, position B is 50x — both 15x+
        let cp = price(0.0001);
        // Sell a small amount to trigger consolidation
        on_sell(&mut wallet, 10_000_000, cp).unwrap();

        // Should be consolidated into one position
        assert_eq!(wallet.positions.len(), 1);
        assert_eq!(wallet.positions[0].unlocked_bps, 10_000);
    }

    // ── Merge helpers ──

    #[test]
    fn test_find_mergeable_exact_same_price() {
        let positions = vec![Position {
            entry_price: price(0.000003),
            initial_sol: 3_000_000,
            token_balance: 1_000_000_000,
            unlocked_bps: 0,
            original_balance: 0,
        }];
        assert_eq!(
            find_mergeable_position(&positions, price(0.000003)),
            Some(0)
        );
    }

    #[test]
    fn test_find_mergeable_at_boundary() {
        let positions = vec![Position {
            entry_price: price(0.000003),
            initial_sol: 3_000_000_000,
            token_balance: 1_000_000_000,
            unlocked_bps: 0,
            original_balance: 0,
        }];
        // 9% higher — should merge (within 10% threshold)
        assert!(find_mergeable_position(&positions, price(0.00000327)).is_some());
        // 11% higher — should NOT merge (outside 10% threshold)
        assert!(find_mergeable_position(&positions, price(0.00000333)).is_none());
    }

    #[test]
    fn test_merge_closest_pair_picks_nearest() {
        let mut positions = vec![
            Position {
                entry_price: price(0.00001),
                initial_sol: 10_000_000,
                token_balance: 100_000_000,
                unlocked_bps: 0,
                original_balance: 100_000_000,
            },
            Position {
                entry_price: price(0.00005),
                initial_sol: 50_000_000,
                token_balance: 100_000_000,
                unlocked_bps: 0,
                original_balance: 100_000_000,
            },
            Position {
                entry_price: price(0.00006),
                initial_sol: 60_000_000,
                token_balance: 100_000_000,
                unlocked_bps: 0,
                original_balance: 100_000_000,
            },
        ];

        merge_closest_pair(&mut positions).unwrap();
        // Should merge the 0.00005 and 0.00006 pair (closest)
        assert_eq!(positions.len(), 2);
        // First position untouched
        assert_eq!(positions[0].entry_price, price(0.00001));
        // Second position is the merged one with 200M tokens
        assert_eq!(positions[1].token_balance, 200_000_000);
    }
}
