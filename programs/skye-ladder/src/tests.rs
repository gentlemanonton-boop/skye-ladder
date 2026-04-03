/// Comprehensive test suite for Skye Ladder — 50+ test cases.
///
/// These tests exercise the full stack: math → positions → anti-bundle → pool_price,
/// simulating real user flows from launch through 15x+ appreciation.
///
/// Test naming: test_{module}_{scenario}_{expected_outcome}
#[cfg(test)]
mod comprehensive {
    use crate::anti_bundle;
    use crate::math::{calculate_unlocked_bps, effective_unlock_bps, sellable_tokens};
    use crate::pool_price;
    use crate::positions::{on_buy, on_sell};
    use crate::state::{Position, WalletRecord, PRICE_SCALE, USD_SCALE, BPS_DENOMINATOR};
    use anchor_lang::prelude::Pubkey;

    // ═══════════════════════════════════════════════════════════════════════
    // Helpers
    // ═══════════════════════════════════════════════════════════════════════

    fn price(usd: f64) -> u64 {
        (usd * PRICE_SCALE as f64) as u64
    }

    fn price_at_mult(entry: u64, mult: f64) -> u64 {
        ((entry as f64) * mult) as u64
    }

    fn usd(amount: f64) -> u64 {
        (amount * USD_SCALE as f64) as u64
    }

    fn wallet() -> WalletRecord {
        WalletRecord {
            owner: Pubkey::new_unique(),
            mint: Pubkey::new_unique(),
            position_count: 0,
            positions: vec![],
            last_buy_slot: 0,
            slot_buy_usd: 0,
            bump: 0,
        }
    }

    fn pos(entry_usd: f64, tokens: u64) -> Position {
        let ep = price(entry_usd);
        let iusd = (tokens as f64 * entry_usd * USD_SCALE as f64) as u64;
        Position {
            entry_price: ep,
            initial_usd: iusd,
            token_balance: tokens,
            unlocked_bps: 0,
            original_balance: tokens,
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 1–10: Core unlock calculation edge cases
    // ═══════════════════════════════════════════════════════════════════════

    // 1. Exact entry price → 100% sellable (underwater = entry)
    #[test]
    fn test_01_unlock_at_exact_entry() {
        let p = pos(0.000003, 1_000_000_000);
        assert_eq!(calculate_unlocked_bps(p.entry_price, &p).unwrap(), 10_000);
    }

    // 2. Tiny fraction below entry → still 100%
    #[test]
    fn test_02_unlock_slightly_below_entry() {
        let p = pos(0.000003, 1_000_000_000);
        let cp = price_at_mult(p.entry_price, 0.9999);
        assert_eq!(calculate_unlocked_bps(cp, &p).unwrap(), 10_000);
    }

    // 3. Price crashed to near zero → 100%
    #[test]
    fn test_03_unlock_price_near_zero() {
        let p = pos(0.000003, 1_000_000_000);
        let cp = price(0.0000000001);
        assert_eq!(calculate_unlocked_bps(cp, &p).unwrap(), 10_000);
    }

    // 4. Phase 1 at exactly 1.5x → ~66.67%
    #[test]
    fn test_04_phase1_at_1_5x() {
        let p = pos(0.000003, 1_000_000_000);
        let cp = price_at_mult(p.entry_price, 1.5);
        let bps = calculate_unlocked_bps(cp, &p).unwrap();
        assert!(bps >= 6_660 && bps <= 6_670, "1.5x should be ~6666 bps, got {}", bps);
    }

    // 5. Phase 1 natural taper: at 1.01x → ~99%
    #[test]
    fn test_05_phase1_just_above_entry() {
        let p = pos(0.000003, 1_000_000_000);
        let cp = price_at_mult(p.entry_price, 1.01);
        let bps = calculate_unlocked_bps(cp, &p).unwrap();
        assert!(bps >= 9_890, "1.01x should be ~99%, got {} bps", bps);
    }

    // 6. Phase 1 → Phase 2 boundary at 2x → exactly 5000
    #[test]
    fn test_06_phase_boundary_2x() {
        let p = pos(0.000003, 1_000_000_000);
        let cp = price_at_mult(p.entry_price, 2.0);
        assert_eq!(calculate_unlocked_bps(cp, &p).unwrap(), 5_000);
    }

    // 7. Phase 2 compressed growth at 3x
    #[test]
    fn test_07_phase2_at_3x() {
        let p = pos(0.000003, 1_000_000_000);
        let cp = price_at_mult(p.entry_price, 3.0);
        let bps = calculate_unlocked_bps(cp, &p).unwrap();
        // progress = (3-2)/(5-2) = 1/3, growth = 1/3 * 1250 / 2 = 208
        // total = 5000 + 208 = 5208
        assert!(bps >= 5_205 && bps <= 5_215, "3x should be ~5208 bps, got {}", bps);
    }

    // 8. Phase 2 max (just below 5x) → ~5623 (NOT 6250)
    #[test]
    fn test_08_phase2_just_below_5x() {
        let p = pos(0.000003, 1_000_000_000);
        let cp = price_at_mult(p.entry_price, 4.99);
        let bps = calculate_unlocked_bps(cp, &p).unwrap();
        assert!(bps < 6_250, "Below 5x cliff, got {}", bps);
        assert!(bps >= 5_600, "Should be near Phase 2 max, got {}", bps);
    }

    // 9. 5x cliff jump
    #[test]
    fn test_09_cliff_jump_at_5x() {
        let p = pos(0.000003, 1_000_000_000);
        let below = calculate_unlocked_bps(price_at_mult(p.entry_price, 4.99), &p).unwrap();
        let at = calculate_unlocked_bps(price_at_mult(p.entry_price, 5.0), &p).unwrap();
        assert_eq!(at, 6_250);
        assert!(at - below >= 600, "Cliff should be ~625 bps, got {}", at - below);
    }

    // 10. Phase 4 max (just below 15x) → ~8747 (compressed, NOT 10000)
    #[test]
    fn test_10_phase4_just_below_15x() {
        let p = pos(0.000003, 1_000_000_000);
        let cp = price_at_mult(p.entry_price, 14.99);
        let bps = calculate_unlocked_bps(cp, &p).unwrap();
        assert!(bps < 10_000, "Below 15x cliff, got {}", bps);
        // Compressed: 7500 + (4.99/5 * 2500 / 2) = 8747
        assert!(bps >= 8_740, "Should be near Phase 4 max, got {}", bps);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 11–20: High-water mark and effective unlock
    // ═══════════════════════════════════════════════════════════════════════

    // 11. High-water mark persists after price dip
    #[test]
    fn test_11_high_water_survives_dip() {
        let mut p = pos(0.000003, 1_000_000_000);
        let at_10x = price_at_mult(p.entry_price, 10.0);
        effective_unlock_bps(at_10x, &mut p).unwrap();
        assert_eq!(p.unlocked_bps, 7_500);

        // Price dips to 2x
        let at_2x = price_at_mult(p.entry_price, 2.0);
        let bps = effective_unlock_bps(at_2x, &mut p).unwrap();
        assert_eq!(bps, 7_500, "High-water should preserve 7500");
    }

    // 12. High-water mark increases on further appreciation
    #[test]
    fn test_12_high_water_increases() {
        let mut p = pos(0.000003, 1_000_000_000);
        effective_unlock_bps(price_at_mult(p.entry_price, 5.0), &mut p).unwrap();
        assert_eq!(p.unlocked_bps, 6_250);

        effective_unlock_bps(price_at_mult(p.entry_price, 10.0), &mut p).unwrap();
        assert_eq!(p.unlocked_bps, 7_500);

        effective_unlock_bps(price_at_mult(p.entry_price, 15.0), &mut p).unwrap();
        assert_eq!(p.unlocked_bps, 10_000);
    }

    // 13. High-water at 0 (fresh position, underwater)
    #[test]
    fn test_13_fresh_position_underwater() {
        let mut p = pos(0.000003, 1_000_000_000);
        assert_eq!(p.unlocked_bps, 0);
        let bps = effective_unlock_bps(price_at_mult(p.entry_price, 0.5), &mut p).unwrap();
        assert_eq!(bps, 10_000);
        assert_eq!(p.unlocked_bps, 10_000);
    }

    // 14. Sellable tokens rounds DOWN
    #[test]
    fn test_14_sellable_rounds_down() {
        let mut p = Position {
            entry_price: price(0.000003),
            initial_usd: usd(3.0),
            token_balance: 333, // odd number
            unlocked_bps: 0,
            original_balance: 333,
        };
        let cp = price_at_mult(p.entry_price, 5.0); // 62.5%
        let (sellable, _) = sellable_tokens(cp, &mut p).unwrap();
        // 333 * 6250 / 10000 = 208.125 → rounds to 208
        assert_eq!(sellable, 208);
    }

    // 15. Sellable at 100% returns full balance
    #[test]
    fn test_15_sellable_at_100_percent() {
        let mut p = pos(0.000003, 1_000_000_000);
        let cp = price_at_mult(p.entry_price, 15.0);
        let (sellable, bps) = sellable_tokens(cp, &mut p).unwrap();
        assert_eq!(bps, 10_000);
        assert_eq!(sellable, 1_000_000_000);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 16–30: Position management (buy/sell/merge)
    // ═══════════════════════════════════════════════════════════════════════

    // 16. Single buy creates a position with correct initial_usd
    #[test]
    fn test_16_single_buy_initial_usd() {
        let mut w = wallet();
        let cp = price(0.000003);
        on_buy(&mut w, 1_000_000_000, cp).unwrap();
        // initial_usd = 1B * 0.000003 = $3000 = 3_000_000_000 in USD_SCALE
        let iusd = w.positions[0].initial_usd;
        assert!(iusd >= 2_990_000_000 && iusd <= 3_010_000_000, "initial_usd={}", iusd);
    }

    // 17. Two buys at same price merge
    #[test]
    fn test_17_buys_same_price_merge() {
        let mut w = wallet();
        let cp = price(0.000003);
        on_buy(&mut w, 500_000_000, cp).unwrap();
        on_buy(&mut w, 500_000_000, cp).unwrap();
        assert_eq!(w.positions.len(), 1);
        assert_eq!(w.positions[0].token_balance, 1_000_000_000);
    }

    // 18. Two buys at 9% apart merge (within threshold)
    #[test]
    fn test_18_buys_9pct_apart_merge() {
        let mut w = wallet();
        on_buy(&mut w, 500_000_000, price(0.000003)).unwrap();
        on_buy(&mut w, 500_000_000, price(0.00000327)).unwrap(); // 9% higher
        assert_eq!(w.positions.len(), 1);
    }

    // 19. Two buys at 11% apart stay separate
    #[test]
    fn test_19_buys_11pct_apart_separate() {
        let mut w = wallet();
        on_buy(&mut w, 500_000_000, price(0.000003)).unwrap();
        on_buy(&mut w, 500_000_000, price(0.00000333)).unwrap(); // 11% higher
        assert_eq!(w.positions.len(), 2);
    }

    // 20. Weighted average entry price after merge
    #[test]
    fn test_20_merge_weighted_avg_price() {
        let mut w = wallet();
        let cp1 = price(0.000003);
        on_buy(&mut w, 1_000_000_000, cp1).unwrap();
        let cp2 = price(0.0000032); // ~6.7% higher, within merge range
        on_buy(&mut w, 500_000_000, cp2).unwrap();
        assert_eq!(w.positions.len(), 1);
        // Merged position has 1.5B tokens
        assert_eq!(w.positions[0].token_balance, 1_500_000_000);
        // Weighted avg entry: total_usd / total_tokens
        // The merge uses: total_cost * PRICE_SCALE / (total_tokens * USD_SCALE)
        // This produces a weighted average entry price
        let ep = w.positions[0].entry_price;
        // Should be between cp1 and cp2
        assert!(ep > cp1 && ep < cp2, "Weighted avg entry: {}", ep);
    }

    // 21. Cap at 10 positions forces merge
    #[test]
    fn test_21_cap_forces_merge() {
        let mut w = wallet();
        // Create 10 positions at widely different prices
        for i in 1..=10 {
            on_buy(&mut w, 100_000_000, price(0.00001 * i as f64)).unwrap();
        }
        assert_eq!(w.positions.len(), 10);

        // 11th buy at a very different price
        on_buy(&mut w, 100_000_000, price(0.001)).unwrap();
        assert!(w.positions.len() <= 10, "Should stay at cap, got {}", w.positions.len());
    }

    // 22. Sell underwater: full exit allowed
    #[test]
    fn test_22_sell_full_underwater() {
        let mut w = wallet();
        on_buy(&mut w, 1_000_000_000, price(0.000003)).unwrap();
        let cp = price(0.000001); // way below entry
        on_sell(&mut w, 1_000_000_000, cp).unwrap();
        assert_eq!(w.positions.len(), 0);
    }

    // 23. Sell exactly the unlocked amount succeeds
    #[test]
    fn test_23_sell_exact_unlock() {
        let mut w = wallet();
        on_buy(&mut w, 1_000_000_000, price(0.000003)).unwrap();
        let cp = price_at_mult(w.positions[0].entry_price, 5.0);
        // 62.5% of 1B = 625M
        on_sell(&mut w, 625_000_000, cp).unwrap();
        assert_eq!(w.positions[0].token_balance, 375_000_000);
    }

    // 24. Sell 1 token over the limit reverts
    #[test]
    fn test_24_sell_over_limit_reverts() {
        let mut w = wallet();
        on_buy(&mut w, 1_000_000_000, price(0.000003)).unwrap();
        let cp = price_at_mult(w.positions[0].entry_price, 5.0);
        let result = on_sell(&mut w, 625_000_001, cp);
        assert!(result.is_err());
    }

    // 25. Sell drains highest mult position first
    #[test]
    fn test_25_sell_highest_mult_first() {
        let mut w = wallet();
        on_buy(&mut w, 500_000_000, price(0.000001)).unwrap(); // will be 50x at test price
        on_buy(&mut w, 500_000_000, price(0.00005)).unwrap();  // will be 1x at test price
        let cp = price(0.00005); // 50x for pos A, 1x for pos B
        // Sell 500M: should drain pos A entirely (fully unlocked at 50x)
        on_sell(&mut w, 500_000_000, cp).unwrap();
        assert_eq!(w.positions.len(), 1);
        assert_eq!(w.positions[0].entry_price, price(0.00005));
    }

    // 26. Sell across two positions
    #[test]
    fn test_26_sell_across_positions() {
        let mut w = wallet();
        on_buy(&mut w, 400_000_000, price(0.000003)).unwrap(); // 50x at test price
        on_buy(&mut w, 600_000_000, price(0.00003)).unwrap();  // 5x at test price

        let cp = price(0.00015);
        // Pos A: 50x → 100% sellable → 400M
        // Pos B: 5x → 62.5% → 375M sellable
        // Total sellable = 775M
        on_sell(&mut w, 700_000_000, cp).unwrap();
        // Should drain A (400M) and take 300M from B
        let remaining_b = w.positions.iter().find(|p| !p.is_empty());
        assert!(remaining_b.is_some());
        assert_eq!(remaining_b.unwrap().token_balance, 300_000_000);
    }

    // 27. Partial sell, then second partial sell (from original balance)
    #[test]
    fn test_27_sequential_partial_sells() {
        let mut w = wallet();
        on_buy(&mut w, 1_000_000_000, price(0.000003)).unwrap();
        let cp = price_at_mult(w.positions[0].entry_price, 10.0); // 75%

        // First sell: 500M (max from original = 750M, so 500M ok)
        on_sell(&mut w, 500_000_000, cp).unwrap();
        assert_eq!(w.positions[0].token_balance, 500_000_000);

        // Second sell: remaining allowed = 750M - 500M = 250M
        on_sell(&mut w, 250_000_000, cp).unwrap();
        assert_eq!(w.positions[0].token_balance, 250_000_000);

        // Third sell should fail (already sold 750M of 750M allowed)
        let result = on_sell(&mut w, 1, cp);
        assert!(result.is_err(), "Should block: 75% of original already sold");
    }

    // 28. Empty positions cleaned up after sell
    #[test]
    fn test_28_empty_positions_cleaned() {
        let mut w = wallet();
        on_buy(&mut w, 100_000_000, price(0.000003)).unwrap();
        let cp = price_at_mult(w.positions[0].entry_price, 0.5); // underwater → 100%
        on_sell(&mut w, 100_000_000, cp).unwrap();
        assert_eq!(w.positions.len(), 0);
        assert_eq!(w.position_count, 0);
    }

    // 29. Phase 5 positions consolidated after sell
    #[test]
    fn test_29_phase5_consolidation() {
        let mut w = wallet();
        on_buy(&mut w, 200_000_000, price(0.000001)).unwrap();
        on_buy(&mut w, 200_000_000, price(0.000002)).unwrap();
        on_buy(&mut w, 200_000_000, price(0.000003)).unwrap();
        assert_eq!(w.positions.len(), 3);

        // At price 0.001: all positions are >100x → all Phase 5
        let cp = price(0.001);
        on_sell(&mut w, 10_000_000, cp).unwrap();
        // Should consolidate into 1 position
        assert_eq!(w.positions.len(), 1);
        assert_eq!(w.positions[0].unlocked_bps, 10_000);
    }

    // 30. Zero sell amount reverts
    #[test]
    fn test_30_zero_sell_reverts() {
        let mut w = wallet();
        on_buy(&mut w, 1_000_000_000, price(0.000003)).unwrap();
        let result = on_sell(&mut w, 0, price(0.000006));
        assert!(result.is_err());
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 31–40: Anti-bundle / per-block buy limits
    // ═══════════════════════════════════════════════════════════════════════

    fn price_for_mc(mc_usd: f64) -> u64 {
        // With sol_price=$1 (1_000_000), SUPPLY_RAW=10^18:
        // price = mc_scaled * PRICE_SCALE * LAMPORTS / (SUPPLY_RAW * sol_price)
        let mc_scaled = mc_usd * 1_000_000.0;
        let p = mc_scaled * PRICE_SCALE as f64 * 1_000_000_000.0
            / (1_000_000_000_000_000_000.0 * 1_000_000.0);
        p as u64
    }

    // 31. Under $5K MC: $100 limit enforced
    #[test]
    fn test_31_anti_bundle_under_5k() {
        let mut w = wallet();
        let cp = price_for_mc(3_000.0);
        anti_bundle::enforce_buy_limit(&mut w, usd(100.0), cp, 1_000_000, 1).unwrap();
        assert!(anti_bundle::enforce_buy_limit(&mut w, usd(0.01), cp, 1_000_000, 1).is_err());
    }

    // 32. $5K–$10K MC: $250 limit
    #[test]
    fn test_32_anti_bundle_5k_10k() {
        let mut w = wallet();
        let cp = price_for_mc(7_500.0);
        anti_bundle::enforce_buy_limit(&mut w, usd(250.0), cp, 1_000_000, 1).unwrap();
        assert!(anti_bundle::enforce_buy_limit(&mut w, usd(0.01), cp, 1_000_000, 1).is_err());
    }

    // 33. $10K–$25K MC: $500 limit
    #[test]
    fn test_33_anti_bundle_10k_25k() {
        let mut w = wallet();
        let cp = price_for_mc(20_000.0);
        anti_bundle::enforce_buy_limit(&mut w, usd(500.0), cp, 1_000_000, 1).unwrap();
        assert!(anti_bundle::enforce_buy_limit(&mut w, usd(0.01), cp, 1_000_000, 1).is_err());
    }

    // 34. $25K–$50K MC: $1,000 limit
    #[test]
    fn test_34_anti_bundle_25k_50k() {
        let mut w = wallet();
        let cp = price_for_mc(40_000.0);
        anti_bundle::enforce_buy_limit(&mut w, usd(1_000.0), cp, 1_000_000, 1).unwrap();
        assert!(anti_bundle::enforce_buy_limit(&mut w, usd(0.01), cp, 1_000_000, 1).is_err());
    }

    // 35. Above $50K MC: no limit
    #[test]
    fn test_35_anti_bundle_above_50k_no_limit() {
        let mut w = wallet();
        let cp = price_for_mc(100_000.0);
        anti_bundle::enforce_buy_limit(&mut w, usd(1_000_000.0), cp, 1_000_000, 1).unwrap();
    }

    // 36. Limit resets on new slot
    #[test]
    fn test_36_limit_resets_new_slot() {
        let mut w = wallet();
        let cp = price_for_mc(3_000.0);
        anti_bundle::enforce_buy_limit(&mut w, usd(100.0), cp, 1_000_000, 1).unwrap();
        assert!(anti_bundle::enforce_buy_limit(&mut w, usd(1.0), cp, 1_000_000, 1).is_err());
        // New slot resets
        anti_bundle::enforce_buy_limit(&mut w, usd(100.0), cp, 1_000_000, 2).unwrap();
    }

    // 37. Accumulation within same slot
    #[test]
    fn test_37_accumulation_same_slot() {
        let mut w = wallet();
        let cp = price_for_mc(3_000.0);
        anti_bundle::enforce_buy_limit(&mut w, usd(40.0), cp, 1_000_000, 1).unwrap();
        anti_bundle::enforce_buy_limit(&mut w, usd(40.0), cp, 1_000_000, 1).unwrap();
        anti_bundle::enforce_buy_limit(&mut w, usd(20.0), cp, 1_000_000, 1).unwrap();
        // $100 used, $0 remaining
        assert!(anti_bundle::enforce_buy_limit(&mut w, usd(0.01), cp, 1_000_000, 1).is_err());
    }

    // 38. Exact limit boundary passes
    #[test]
    fn test_38_exact_boundary() {
        let mut w = wallet();
        let cp = price_for_mc(3_000.0);
        anti_bundle::enforce_buy_limit(&mut w, usd(50.0), cp, 1_000_000, 1).unwrap();
        anti_bundle::enforce_buy_limit(&mut w, usd(50.0), cp, 1_000_000, 1).unwrap(); // exactly $100
    }

    // 39. MC at exact tier boundary ($5K)
    #[test]
    fn test_39_mc_at_exact_boundary() {
        let mut w = wallet();
        // At exactly $5K MC → should use $250 tier (next tier up)
        let cp = price_for_mc(5_000.0);
        anti_bundle::enforce_buy_limit(&mut w, usd(250.0), cp, 1_000_000, 1).unwrap();
    }

    // 40. tokens_to_usd conversion accuracy
    #[test]
    fn test_40_tokens_to_usd() {
        // With sol_price=$1, 1M human tokens at MC=$3K should be worth $3
        let cp = price_for_mc(3_000.0);
        let amount_raw = 1_000_000u64 * 1_000_000_000; // 1M human tokens
        let val = anti_bundle::tokens_to_usd(amount_raw, cp, 1_000_000).unwrap();
        assert!(val >= 2_700_000 && val <= 3_300_000, "Got {}", val);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 41–50: End-to-end user scenarios
    // ═══════════════════════════════════════════════════════════════════════

    // 41. Full lifecycle: buy → price moons → sell in stages
    #[test]
    fn test_41_full_lifecycle_moon() {
        let mut w = wallet();
        let entry = price(0.000003);
        on_buy(&mut w, 1_000_000_000, entry).unwrap();

        // Price goes to 5x → sell 62.5% of original = 625M
        let cp_5x = price_at_mult(entry, 5.0);
        on_sell(&mut w, 625_000_000, cp_5x).unwrap();
        assert_eq!(w.positions[0].token_balance, 375_000_000);

        // Price goes to 10x → 75% of original = 750M, already sold 625M → 125M more
        let cp_10x = price_at_mult(entry, 10.0);
        on_sell(&mut w, 125_000_000, cp_10x).unwrap();
        assert_eq!(w.positions[0].token_balance, 250_000_000);

        // Price goes to 15x → 100% unlocked → sell everything remaining
        let cp_15x = price_at_mult(entry, 15.0);
        let remaining = w.positions[0].token_balance;
        on_sell(&mut w, remaining, cp_15x).unwrap();
        assert_eq!(w.positions.len(), 0);
    }

    // 42. DCA buyer: 5 buys over price appreciation
    #[test]
    fn test_42_dca_buyer() {
        let mut w = wallet();
        on_buy(&mut w, 200_000_000, price(0.000003)).unwrap();
        on_buy(&mut w, 200_000_000, price(0.000006)).unwrap();
        on_buy(&mut w, 200_000_000, price(0.000012)).unwrap();
        on_buy(&mut w, 200_000_000, price(0.000024)).unwrap();
        on_buy(&mut w, 200_000_000, price(0.000048)).unwrap();
        // All 5 at different price ranges → 5 separate positions
        assert_eq!(w.positions.len(), 5);
    }

    // 43. Flipper scenario: buy at launch, try to dump at 2.5x
    #[test]
    fn test_43_flipper_restricted() {
        let mut w = wallet();
        let entry = price(0.000003);
        on_buy(&mut w, 1_000_000_000, entry).unwrap();

        // Price at 2.5x → compressed Phase 2
        let cp = price_at_mult(entry, 2.5);
        // Unlock: 5000 + (0.5/3 * 1250 / 2) ≈ 5104
        // Sellable: ~51% of 1B = ~510M
        // Can't sell 100%
        let result = on_sell(&mut w, 1_000_000_000, cp);
        assert!(result.is_err(), "Flipper should be restricted at 2.5x");

        // Check how much is actually sellable
        let p = &w.positions[0];
        let bps = crate::math::calculate_unlocked_bps(cp, p).unwrap();
        let sellable = (p.token_balance as u128) * (bps as u128) / 10_000;
        // Sell exactly the unlocked amount
        on_sell(&mut w, sellable as u64, cp).unwrap();
    }

    // 44. Wallet-to-wallet transfer as sell + new position
    #[test]
    fn test_44_transfer_as_sell_plus_buy() {
        let mut sender = wallet();
        let entry = price(0.000003);
        on_buy(&mut sender, 1_000_000_000, entry).unwrap();

        // At 5x, sender can transfer up to 62.5%
        let cp = price_at_mult(entry, 5.0);

        // Simulate transfer: sell from sender
        on_sell(&mut sender, 625_000_000, cp).unwrap();
        assert_eq!(sender.positions[0].token_balance, 375_000_000);

        // Buy for receiver at current price
        let mut receiver = wallet();
        on_buy(&mut receiver, 625_000_000, cp).unwrap();
        assert_eq!(receiver.positions[0].token_balance, 625_000_000);
        assert_eq!(receiver.positions[0].entry_price, cp);
    }

    // 45. Partial sell then price dip — high-water preserves selling power
    #[test]
    fn test_45_dip_after_partial_sell() {
        let mut w = wallet();
        let entry = price(0.000003);
        on_buy(&mut w, 1_000_000_000, entry).unwrap();

        // Sell 200M at 10x (75% of 1B = 750M allowed)
        let cp_10x = price_at_mult(entry, 10.0);
        on_sell(&mut w, 200_000_000, cp_10x).unwrap();
        assert_eq!(w.positions[0].unlocked_bps, 7_500);

        // Price dips to 3x — high-water keeps 75%
        // Already sold 200M of 750M allowed → 550M still sellable
        let cp_3x = price_at_mult(entry, 3.0);
        on_sell(&mut w, 550_000_000, cp_3x).unwrap();
        assert_eq!(w.positions[0].token_balance, 250_000_000);
    }

    // 46. Multiple positions, some underwater, some in profit
    #[test]
    fn test_46_mixed_underwater_profit() {
        let mut w = wallet();
        on_buy(&mut w, 500_000_000, price(0.00001)).unwrap();  // will be underwater
        on_buy(&mut w, 500_000_000, price(0.000001)).unwrap(); // will be 10x

        let cp = price(0.00001); // pos A: 1x (underwater), pos B: 10x
        // Pos A: 100% sellable (underwater) = 500M
        // Pos B: 75% (10x) = 375M
        // Total = 875M
        on_sell(&mut w, 875_000_000, cp).unwrap();
    }

    // 47. Buy zero tokens reverts
    #[test]
    fn test_47_buy_zero_reverts() {
        let mut w = wallet();
        assert!(on_buy(&mut w, 0, price(0.000003)).is_err());
    }

    // 48. Buy at zero price reverts
    #[test]
    fn test_48_buy_zero_price_reverts() {
        let mut w = wallet();
        assert!(on_buy(&mut w, 1_000_000_000, 0).is_err());
    }

    // 49. Sell more than total balance reverts
    #[test]
    fn test_49_sell_more_than_balance_reverts() {
        let mut w = wallet();
        on_buy(&mut w, 1_000_000_000, price(0.000003)).unwrap();
        let cp = price_at_mult(w.positions[0].entry_price, 15.0); // fully unlocked
        assert!(on_sell(&mut w, 1_000_000_001, cp).is_err());
    }

    // 50. Remaining balance after partial sell becomes new base
    #[test]
    fn test_50_remaining_is_new_base() {
        let mut w = wallet();
        let entry = price(0.000003);
        on_buy(&mut w, 1_000_000_000, entry).unwrap();

        // At 1.5x, sell ~66.67% (Phase 1: initial_usd / current_value)
        let cp = price_at_mult(entry, 1.5);
        on_sell(&mut w, 600_000_000, cp).unwrap();

        // Remaining: 400M tokens. Same initial_usd.
        // At same price, sellable % should be higher because balance is smaller.
        let remaining = w.positions[0].token_balance;
        assert_eq!(remaining, 400_000_000);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 51–60: Pool price reader tests (AMM constant-product format)
    // ═══════════════════════════════════════════════════════════════════════

    const SKYE_AMOUNT_OFFSET: usize = 200;
    const WSOL_AMOUNT_OFFSET: usize = 208;

    fn mock_amm_pool(skye_amount: u64, wsol_amount: u64) -> Vec<u8> {
        let mut data = vec![0u8; 256];
        data[SKYE_AMOUNT_OFFSET..SKYE_AMOUNT_OFFSET + 8]
            .copy_from_slice(&skye_amount.to_le_bytes());
        data[WSOL_AMOUNT_OFFSET..WSOL_AMOUNT_OFFSET + 8]
            .copy_from_slice(&wsol_amount.to_le_bytes());
        data
    }

    // 51. Equal reserves → price = 1.0
    #[test]
    fn test_51_equal_reserves() {
        let data = mock_amm_pool(1_000_000_000, 1_000_000_000);
        let price = pool_price::read_spot_price_from_pool(&data).unwrap();
        assert_eq!(price, PRICE_SCALE as u64);
    }

    // 52. More WSOL than SKYE → price > 1.0
    #[test]
    fn test_52_price_above_1() {
        let data = mock_amm_pool(1_000_000_000, 2_000_000_000);
        let price = pool_price::read_spot_price_from_pool(&data).unwrap();
        assert!((price as u128) > PRICE_SCALE);
        // Should be 2.0
        let ratio = price as f64 / PRICE_SCALE as f64;
        assert!((ratio - 2.0).abs() < 0.001, "Ratio: {}", ratio);
    }

    // 53. Less WSOL than SKYE → price < 1.0
    #[test]
    fn test_53_price_below_1() {
        let data = mock_amm_pool(2_000_000_000, 1_000_000_000);
        let price = pool_price::read_spot_price_from_pool(&data).unwrap();
        assert!((price as u128) < PRICE_SCALE);
        // Should be 0.5
        let ratio = price as f64 / PRICE_SCALE as f64;
        assert!((ratio - 0.5).abs() < 0.001, "Ratio: {}", ratio);
    }

    // 54. Zero SKYE rejected
    #[test]
    fn test_54_zero_skye_rejected() {
        let data = mock_amm_pool(0, 1_000_000_000);
        assert!(pool_price::read_spot_price_from_pool(&data).is_err());
    }

    // 55. Zero WSOL rejected
    #[test]
    fn test_55_zero_wsol_rejected() {
        let data = mock_amm_pool(1_000_000_000, 0);
        assert!(pool_price::read_spot_price_from_pool(&data).is_err());
    }

    // 56. Short data rejected
    #[test]
    fn test_56_short_data_rejected() {
        let data = vec![0u8; 50];
        assert!(pool_price::read_spot_price_from_pool(&data).is_err());
    }

    // 57. Very small price (launch scenario)
    #[test]
    fn test_57_very_small_price() {
        // 1B SKYE (9 dec) vs 0.023 SOL (9 dec) → ~$3K MC at SOL=$130
        let skye = 1_000_000_000u64 * 1_000_000_000;
        let wsol = 23_000_000u64;
        let data = mock_amm_pool(skye, wsol);
        let price = pool_price::read_spot_price_from_pool(&data).unwrap();
        assert!(price > 0);
        assert!((price as u128) < PRICE_SCALE);
    }

    // 58. Price after 15x appreciation
    #[test]
    fn test_58_price_15x() {
        let skye_launch = 1_000_000_000u64 * 1_000_000_000;
        let wsol_launch = 23_000_000u64;
        let data_launch = mock_amm_pool(skye_launch, wsol_launch);
        let launch_price = pool_price::read_spot_price_from_pool(&data_launch).unwrap();

        // After 15x: wsol increased 15x (or skye decreased proportionally)
        let data_15x = mock_amm_pool(skye_launch, wsol_launch * 15);
        let moon_price = pool_price::read_spot_price_from_pool(&data_15x).unwrap();

        let multiplier = moon_price as f64 / launch_price as f64;
        assert!(
            (multiplier - 15.0).abs() < 0.01,
            "Expected 15x, got {}x", multiplier
        );
    }

    // 59. Precision at extreme ratios
    #[test]
    fn test_59_extreme_ratio() {
        // 10^18 SKYE, 1 WSOL lamport
        let data = mock_amm_pool(1_000_000_000_000_000_000, 1);
        let price = pool_price::read_spot_price_from_pool(&data).unwrap();
        assert!(price > 0, "Should produce non-zero price even at extreme ratio");
    }

    // 60. Price proportionality
    #[test]
    fn test_60_price_proportionality() {
        let data1 = mock_amm_pool(1_000_000, 500_000);
        let data2 = mock_amm_pool(2_000_000, 1_000_000);
        let p1 = pool_price::read_spot_price_from_pool(&data1).unwrap();
        let p2 = pool_price::read_spot_price_from_pool(&data2).unwrap();
        // Same ratio → same price
        assert_eq!(p1, p2);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 61–65: Compressed growth verification & monotonicity
    // ═══════════════════════════════════════════════════════════════════════

    // 61. Compressed growth is exactly half of full linear in Phase 2
    #[test]
    fn test_61_compressed_half_linear_phase2() {
        let p = pos(0.000003, 1_000_000_000);
        let at_2x = calculate_unlocked_bps(price_at_mult(p.entry_price, 2.0), &p).unwrap();
        let at_5x = 6_250u32; // cliff value

        // Full linear midpoint (3.5x) would be: 5000 + (5000..6250 range / 2) = 5000 + 625 = 5625
        // Compressed midpoint should be: 5000 + 312 = 5312
        let mid = calculate_unlocked_bps(price_at_mult(p.entry_price, 3.5), &p).unwrap();
        let full_linear_mid = at_2x + (at_5x - at_2x) / 2;
        let compressed_mid = at_2x + (at_5x - at_2x) / 4; // half the growth

        assert!(
            (mid as i32 - compressed_mid as i32).unsigned_abs() <= 5,
            "Compressed mid: {}, expected ~{}", mid, compressed_mid
        );
        assert!(
            mid < full_linear_mid,
            "Compressed {} should be < full linear {}", mid, full_linear_mid
        );
    }

    // 62. Monotonic increase across all phases (2x+)
    #[test]
    fn test_62_monotonic_from_2x_to_20x() {
        let p = pos(0.000003, 1_000_000_000);
        let mults: Vec<f64> = (200..=2000).step_by(10).map(|m| m as f64 / 100.0).collect();

        let mut prev = 0u32;
        for m in &mults {
            let cp = price_at_mult(p.entry_price, *m);
            if cp == 0 { continue; }
            let bps = calculate_unlocked_bps(cp, &p).unwrap();
            assert!(bps >= prev, "Not monotonic at {}x: {} < {}", m, bps, prev);
            prev = bps;
        }
    }

    // 63. All cliff jumps are positive
    #[test]
    fn test_63_all_cliffs_positive() {
        let p = pos(0.000003, 1_000_000_000);

        let cliffs = [
            (4.99, 5.0, 6_250),
            (9.99, 10.0, 7_500),
        ];

        for (below_m, at_m, cliff_val) in &cliffs {
            let below = calculate_unlocked_bps(price_at_mult(p.entry_price, *below_m), &p).unwrap();
            let at = calculate_unlocked_bps(price_at_mult(p.entry_price, *at_m), &p).unwrap();
            assert_eq!(at, *cliff_val);
            assert!(at > below, "Cliff at {}x should jump: {} > {}", at_m, at, below);
        }
    }

    // 64. Phase 2 growth rate is exactly half of Phase 2 range
    #[test]
    fn test_64_phase2_growth_rate() {
        let p = pos(0.000003, 1_000_000_000);
        // At 4.99x (just before cliff): compressed growth should be ~half the full range
        let at_start = calculate_unlocked_bps(price_at_mult(p.entry_price, 2.0), &p).unwrap();
        let near_end = calculate_unlocked_bps(price_at_mult(p.entry_price, 4.99), &p).unwrap();
        let total_growth = near_end - at_start;
        // Full range = 6250 - 5000 = 1250. Half = 625. Compressed max ≈ 623
        assert!(
            total_growth >= 610 && total_growth <= 630,
            "Phase 2 compressed growth: {}, expected ~623", total_growth
        );
    }

    // 65. 15x boundary: one tick below is < 100%, at 15x is exactly 100%
    #[test]
    fn test_65_15x_exact_boundary() {
        let p = pos(0.000003, 1_000_000_000);
        let at_14_99 = calculate_unlocked_bps(price_at_mult(p.entry_price, 14.99), &p).unwrap();
        let at_15 = calculate_unlocked_bps(price_at_mult(p.entry_price, 15.0), &p).unwrap();
        assert!(at_14_99 < 10_000, "14.99x should be < 100%, got {}", at_14_99);
        assert_eq!(at_15, 10_000, "15x should be exactly 100%");
    }
}
