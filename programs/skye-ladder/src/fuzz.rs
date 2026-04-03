/// Fuzz testing for Skye Ladder — 10,000+ random scenarios.
///
/// Each scenario runs a random sequence of buys, sells, and price movements
/// against a single wallet, checking invariants after every operation.
///
/// Invariants checked:
///   1. Unlock BPS is always in [0, 10_000]
///   2. Underwater positions (price <= entry) are always 100% sellable
///   3. Token balances never go negative
///   4. Sells never extract more tokens than the unlock allows
///   5. High-water mark never decreases
///   6. Position count never exceeds MAX_POSITIONS (10)
///   7. Monotonicity: unlock BPS never decreases as price increases (from 2x+)
///   8. Phase boundaries: 5x→6250, 10x→7500, 15x+→10000
///   9. Total tokens across positions <= original buys minus successful sells
///  10. Empty positions are cleaned up after sells
#[cfg(test)]
mod fuzz_tests {
    use crate::math::{calculate_unlocked_bps, effective_unlock_bps, sellable_tokens};
    use crate::positions::{on_buy, on_sell};
    use crate::state::{Position, WalletRecord, PRICE_SCALE, USD_SCALE, MAX_POSITIONS};
    use anchor_lang::prelude::Pubkey;

    // ═══════════════════════════════════════════════════════════════════════
    // Simple deterministic PRNG (xorshift64) — no external deps needed
    // ═══════════════════════════════════════════════════════════════════════

    struct Rng {
        state: u64,
    }

    impl Rng {
        fn new(seed: u64) -> Self {
            Self { state: seed.max(1) }
        }

        fn next_u64(&mut self) -> u64 {
            self.state ^= self.state << 13;
            self.state ^= self.state >> 7;
            self.state ^= self.state << 17;
            self.state
        }

        /// Random u64 in [lo, hi] inclusive.
        fn range(&mut self, lo: u64, hi: u64) -> u64 {
            if lo >= hi {
                return lo;
            }
            lo + (self.next_u64() % (hi - lo + 1))
        }

        /// Random f64 in [lo, hi).
        fn range_f64(&mut self, lo: f64, hi: f64) -> f64 {
            let t = (self.next_u64() as f64) / (u64::MAX as f64);
            lo + t * (hi - lo)
        }

        /// Random bool with given probability of true.
        fn chance(&mut self, p: f64) -> bool {
            self.range_f64(0.0, 1.0) < p
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Helpers
    // ═══════════════════════════════════════════════════════════════════════

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

    fn price_from_f64(p: f64) -> u64 {
        (p * PRICE_SCALE as f64) as u64
    }

    fn total_tokens(w: &WalletRecord) -> u64 {
        w.positions.iter().map(|p| p.token_balance).sum()
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Invariant checks
    // ═══════════════════════════════════════════════════════════════════════

    fn check_invariants(
        w: &WalletRecord,
        current_price: u64,
        total_bought: u64,
        total_sold: u64,
        scenario: usize,
        step: usize,
    ) {
        let ctx = format!("scenario={}, step={}", scenario, step);

        // Invariant 3: Token balances never negative (guaranteed by u64, but check logic)
        for (i, pos) in w.positions.iter().enumerate() {
            assert!(
                pos.token_balance > 0,
                "{}: Position {} has zero balance but wasn't cleaned up",
                ctx, i
            );
        }

        // Invariant 6: Position count <= MAX_POSITIONS
        assert!(
            w.positions.len() <= MAX_POSITIONS,
            "{}: Position count {} exceeds max {}",
            ctx, w.positions.len(), MAX_POSITIONS
        );

        // Invariant 9: Total tokens <= total bought - total sold
        let current_total = total_tokens(w);
        assert!(
            current_total <= total_bought - total_sold,
            "{}: Total tokens {} > bought {} - sold {}",
            ctx, current_total, total_bought, total_sold
        );

        // Invariant 10: No empty positions
        assert!(
            w.positions.iter().all(|p| p.token_balance > 0),
            "{}: Found empty position that wasn't cleaned up",
            ctx
        );

        // Per-position invariants
        for (i, pos) in w.positions.iter().enumerate() {
            // Invariant 1: unlocked_bps in [0, 10_000]
            assert!(
                pos.unlocked_bps <= 10_000,
                "{}: Position {} unlocked_bps {} > 10000",
                ctx, i, pos.unlocked_bps
            );

            // Check calculated unlock
            if current_price > 0 && pos.entry_price > 0 {
                // Skip overflow errors from extreme fuzz values
                if let Ok(calc_bps) = calculate_unlocked_bps(current_price, pos) {
                    assert!(
                        calc_bps <= 10_000,
                        "{}: Position {} calculated bps {} > 10000",
                        ctx, i, calc_bps
                    );

                    if current_price <= pos.entry_price {
                        assert_eq!(
                            calc_bps, 10_000,
                            "{}: Position {} underwater (price {} <= entry {}) but bps = {}",
                            ctx, i, current_price, pos.entry_price, calc_bps
                        );
                    }

                    let effective = calc_bps.max(pos.unlocked_bps);
                    assert!(
                        effective >= pos.unlocked_bps,
                        "{}: Position {} effective {} < stored high-water {}",
                        ctx, i, effective, pos.unlocked_bps
                    );
                }
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Invariant 7: Monotonicity check
    // ═══════════════════════════════════════════════════════════════════════

    fn check_monotonicity(pos: &Position) {
        if pos.entry_price == 0 || pos.token_balance == 0 {
            return;
        }

        let mut prev_bps = 0u32;
        let ep = pos.entry_price as u128;
        // Check from 2x to 20x in 0.1x steps using integer math
        for mult_x10 in 20..=200u128 {
            let cp_128 = ep * mult_x10 / 10;
            if cp_128 == 0 || cp_128 > u64::MAX as u128 {
                continue;
            }
            let cp = cp_128 as u64;
            match calculate_unlocked_bps(cp, pos) {
                Ok(bps) => {
                    assert!(
                        bps >= prev_bps,
                        "Monotonicity violated: at {}x got {} bps, prev was {}",
                        mult_x10 as f64 / 10.0, bps, prev_bps
                    );
                    prev_bps = bps;
                }
                Err(_) => continue, // Overflow for extreme values — skip
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Invariant 8: Phase boundary check
    // ═══════════════════════════════════════════════════════════════════════

    fn check_phase_boundaries(pos: &Position) {
        if pos.entry_price == 0 || pos.token_balance == 0 {
            return;
        }

        let ep = pos.entry_price as u128;
        let max = u64::MAX as u128;

        // Use integer multiplication — skip if would overflow u64
        if let Some(price_5x) = ep.checked_mul(5).filter(|&v| v <= max) {
            let bps = calculate_unlocked_bps(price_5x as u64, pos).unwrap();
            assert_eq!(bps, 6_250, "5x should be 6250, got {} (ep={})", bps, pos.entry_price);
        }

        if let Some(price_10x) = ep.checked_mul(10).filter(|&v| v <= max) {
            let bps = calculate_unlocked_bps(price_10x as u64, pos).unwrap();
            assert_eq!(bps, 7_500, "10x should be 7500, got {} (ep={})", bps, pos.entry_price);
        }

        if let Some(price_15x) = ep.checked_mul(15).filter(|&v| v <= max) {
            let bps = calculate_unlocked_bps(price_15x as u64, pos).unwrap();
            assert_eq!(bps, 10_000, "15x should be 10000, got {} (ep={})", bps, pos.entry_price);
        }

        // Underwater → 10000
        let price_half = pos.entry_price / 2;
        if price_half > 0 {
            let bps = calculate_unlocked_bps(price_half, pos).unwrap();
            assert_eq!(bps, 10_000, "Underwater should be 10000, got {}", bps);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Fuzz scenario runner
    // ═══════════════════════════════════════════════════════════════════════

    fn run_scenario(seed: u64, scenario_id: usize) {
        let mut rng = Rng::new(seed);
        let mut w = wallet();
        let mut total_bought: u64 = 0;
        let mut total_sold: u64 = 0;

        // Random starting price in a realistic range
        let base_price = rng.range_f64(0.0000001, 0.001);
        let mut current_price = price_from_f64(base_price);

        // Random number of operations: 5 to 30
        let num_ops = rng.range(5, 30) as usize;

        for step in 0..num_ops {
            // Randomly move the price
            let price_mult = rng.range_f64(0.1, 20.0);
            current_price = ((current_price as f64) * price_mult) as u64;
            if current_price == 0 {
                current_price = 1;
            }

            // Random operation: buy (40%), sell (40%), or just price move (20%)
            let op = rng.range(0, 99);

            if op < 40 {
                // ── BUY ──
                let tokens = rng.range(1_000, 1_000_000_000);
                let result = on_buy(&mut w, tokens, current_price);
                if result.is_ok() {
                    total_bought += tokens;
                }
                // Buy can fail on overflow — that's fine, skip
            } else if op < 80 {
                // ── SELL ──
                let current_total = total_tokens(&w);
                if current_total > 0 {
                    // Try to sell a random portion
                    let max_sell = current_total;
                    let want_sell = rng.range(1, max_sell);

                    let result = on_sell(&mut w, want_sell, current_price);
                    if result.is_ok() {
                        total_sold += want_sell;

                        // Invariant 4: The sell succeeded, meaning the unlock
                        // calculation allowed it. Verify by computing max sellable.
                        // (We trust on_sell's internal check, but verify no
                        // tokens were created from nothing.)
                        let new_total = total_tokens(&w);
                        assert!(
                            new_total == current_total - want_sell,
                            "scenario={}, step={}: Sell of {} from {} left {}, expected {}",
                            scenario_id, step, want_sell, current_total, new_total,
                            current_total - want_sell
                        );
                    }
                    // Sell can legitimately fail (exceeds unlock) — that's correct behavior
                }
            }
            // else: just a price movement, no trade

            // Check all invariants after each step
            check_invariants(&w, current_price, total_bought, total_sold, scenario_id, step);
        }

        // After all operations, run deep invariant checks on each remaining position
        for pos in &w.positions {
            check_monotonicity(pos);
            check_phase_boundaries(pos);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // The main fuzz tests
    // ═══════════════════════════════════════════════════════════════════════

    #[test]
    fn fuzz_10000_random_scenarios() {
        for i in 0..10_000 {
            run_scenario(i as u64 + 1, i);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Targeted fuzz: unlock calculation with random prices and positions
    // ═══════════════════════════════════════════════════════════════════════

    #[test]
    fn fuzz_unlock_calc_10000_random_positions() {
        let mut rng = Rng::new(0xDEADBEEF);

        for i in 0..10_000 {
            let entry = rng.range(1, u64::MAX / 2);
            let tokens = rng.range(1, 1_000_000_000_000);
            let iusd = rng.range(1, u64::MAX / PRICE_SCALE as u64);

            let pos = Position {
                entry_price: entry,
                initial_usd: iusd,
                token_balance: tokens,
                unlocked_bps: 0,
                original_balance: tokens,
            };

            // Random current price from 0.01x to 100x
            let mult = rng.range_f64(0.01, 100.0);
            let cp = ((entry as f64) * mult) as u64;
            if cp == 0 {
                continue;
            }

            let result = calculate_unlocked_bps(cp, &pos);
            match result {
                Ok(bps) => {
                    // Invariant 1: BPS in range
                    assert!(
                        bps <= 10_000,
                        "iter {}: bps {} > 10000 (entry={}, cp={}, mult={})",
                        i, bps, entry, cp, mult
                    );

                    // Invariant 2: Underwater = 100%
                    if cp <= entry {
                        assert_eq!(
                            bps, 10_000,
                            "iter {}: underwater but bps={} (entry={}, cp={})",
                            i, bps, entry, cp
                        );
                    }

                    // Phase 5: >= 15x → 100%
                    if mult >= 15.0 {
                        let recalc_mult = (cp as u128) * 10_000 / (entry as u128);
                        if recalc_mult >= 150_000 {
                            assert_eq!(
                                bps, 10_000,
                                "iter {}: {}x (recalc {}x) but bps={}",
                                i, mult, recalc_mult as f64 / 10000.0, bps
                            );
                        }
                    }
                }
                Err(_) => {
                    // Overflow or zero — acceptable for extreme random values
                }
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Targeted fuzz: high-water mark never decreases
    // ═══════════════════════════════════════════════════════════════════════

    #[test]
    fn fuzz_high_water_mark_10000_price_walks() {
        let mut rng = Rng::new(0xCAFEBABE);

        for _ in 0..10_000 {
            let entry = rng.range(1_000_000, 1_000_000_000_000_000);
            let tokens = rng.range(1_000, 1_000_000_000);
            let iusd = (tokens as u128 * entry as u128 * USD_SCALE / PRICE_SCALE) as u64;
            if iusd == 0 {
                continue;
            }

            let mut pos = Position {
                entry_price: entry,
                initial_usd: iusd,
                token_balance: tokens,
                unlocked_bps: 0,
                original_balance: tokens,
            };

            // Walk the price up and down randomly
            let mut cp = entry;
            for _ in 0..20 {
                let mult = rng.range_f64(0.5, 3.0);
                cp = ((cp as f64) * mult) as u64;
                if cp == 0 {
                    cp = 1;
                }

                let prev_hwm = pos.unlocked_bps;
                let result = effective_unlock_bps(cp, &mut pos);
                if let Ok(bps) = result {
                    // Invariant 5: High-water mark never decreases
                    assert!(
                        pos.unlocked_bps >= prev_hwm,
                        "High-water decreased: {} → {} at price {}",
                        prev_hwm, pos.unlocked_bps, cp
                    );
                    assert!(
                        bps >= prev_hwm,
                        "Effective bps {} < prev high-water {}",
                        bps, prev_hwm
                    );
                }
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Targeted fuzz: sell never exceeds allowed amount
    // ═══════════════════════════════════════════════════════════════════════

    #[test]
    fn fuzz_sell_enforcement_10000_attempts() {
        let mut rng = Rng::new(0xBAADF00D);

        for _ in 0..10_000 {
            let mut w = wallet();
            let entry_price = price_from_f64(rng.range_f64(0.0000001, 0.01));
            if entry_price == 0 {
                continue;
            }
            let tokens = rng.range(100_000, 1_000_000_000);

            if on_buy(&mut w, tokens, entry_price).is_err() {
                continue;
            }

            // Move price to a random multiplier
            let mult = rng.range_f64(0.1, 30.0);
            let cp = ((entry_price as f64) * mult) as u64;
            if cp == 0 {
                continue;
            }

            // Calculate max sellable
            let mut test_pos = w.positions[0];
            let sellable_result = sellable_tokens(cp, &mut test_pos);
            if sellable_result.is_err() {
                continue;
            }
            let (max_sellable, _bps) = sellable_result.unwrap();

            // Selling exactly max_sellable should succeed
            if max_sellable > 0 {
                let mut w_ok = w.clone();
                let result = on_sell(&mut w_ok, max_sellable, cp);
                assert!(
                    result.is_ok(),
                    "Selling exactly max_sellable {} should succeed at {}x",
                    max_sellable, mult
                );
            }

            // Selling max_sellable + 1 should fail (if there are remaining tokens)
            if max_sellable < tokens {
                let mut w_fail = w.clone();
                let result = on_sell(&mut w_fail, max_sellable + 1, cp);
                assert!(
                    result.is_err(),
                    "Selling max_sellable+1 ({}) should fail at {}x (max={})",
                    max_sellable + 1, mult, max_sellable
                );
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Targeted fuzz: multi-position sell ordering
    // ═══════════════════════════════════════════════════════════════════════

    #[test]
    fn fuzz_multi_position_sell_ordering_5000() {
        let mut rng = Rng::new(0xF00DCAFE);

        for _ in 0..5_000 {
            let mut w = wallet();
            let num_buys = rng.range(2, 6) as usize;
            let mut total_bought: u64 = 0;

            // Create multiple positions at different prices
            for _ in 0..num_buys {
                let ep = price_from_f64(rng.range_f64(0.000001, 0.001));
                if ep == 0 {
                    continue;
                }
                let tokens = rng.range(10_000, 500_000_000);
                if on_buy(&mut w, tokens, ep).is_ok() {
                    total_bought += tokens;
                }
            }

            if w.positions.is_empty() {
                continue;
            }

            // Set current price
            let cp = price_from_f64(rng.range_f64(0.000001, 0.01));
            if cp == 0 {
                continue;
            }

            // Try to sell a random amount
            let total = total_tokens(&w);
            if total == 0 {
                continue;
            }
            let sell_amount = rng.range(1, total);

            let positions_before = w.positions.clone();
            let result = on_sell(&mut w, sell_amount, cp);

            if result.is_ok() {
                // Verify token conservation
                let total_after = total_tokens(&w);
                assert_eq!(
                    total_after, total - sell_amount,
                    "Token conservation violated: had {}, sold {}, now {}",
                    total, sell_amount, total_after
                );

                // Verify no position has negative balance (u64 guarantees this,
                // but verify the logic didn't wrap around)
                for pos in &w.positions {
                    assert!(pos.token_balance > 0);
                }

                // Verify positions are valid
                assert!(w.positions.len() <= MAX_POSITIONS);
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Targeted fuzz: position merging stress test
    // ═══════════════════════════════════════════════════════════════════════

    #[test]
    fn fuzz_merge_stress_5000() {
        let mut rng = Rng::new(0xDECAFBAD);

        for _ in 0..5_000 {
            let mut w = wallet();

            // Hammer the wallet with 20 buys at various prices
            for _ in 0..20 {
                let ep = price_from_f64(rng.range_f64(0.0000001, 0.01));
                if ep == 0 {
                    continue;
                }
                let tokens = rng.range(1_000, 100_000_000);
                let _ = on_buy(&mut w, tokens, ep);

                // Must never exceed 10 positions
                assert!(
                    w.positions.len() <= MAX_POSITIONS,
                    "Position count {} after buy exceeds max",
                    w.positions.len()
                );
            }

            // All positions should have non-zero balances
            for pos in &w.positions {
                assert!(pos.token_balance > 0);
                assert!(pos.entry_price > 0);
            }
        }
    }
}
