use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

use crate::errors::SkyeLadderError;
use crate::pool_price;
use crate::positions;
use crate::state::{Config, WalletRecord, PRICE_SCALE};

/// Transfer hook execute handler — called by Token-2022 on every transfer.
///
/// Classifies the transfer as buy, sell, or wallet-to-wallet:
/// - **Buy (Pool → Wallet):** Create/merge position for the receiver.
/// - **Sell (Wallet → Pool):** Enforce unlock restrictions on the sender.
/// - **Transfer (Wallet → Wallet):** Enforce as sell on sender, create position for receiver.
pub fn handler(ctx: Context<TransferHook>, amount: u64) -> Result<()> {
    let config = &ctx.accounts.config;

    // When paused, skip all hook logic (allow unrestricted transfers)
    if config.paused {
        msg!("Skye Ladder: Hook paused, skipping");
        return Ok(());
    }

    let source = ctx.accounts.source_token.key();
    let destination = ctx.accounts.destination_token.key();
    let pool = config.pool;

    let is_buy = source == pool;
    let is_sell = destination == pool;

    // Read spot price from the AMM pool
    let current_price = read_spot_price(ctx.accounts)?;

    if is_buy {
        // ── BUY: Pool → Wallet ──
        let receiver_record = &mut load_wallet_record_mut(
            &ctx.accounts.receiver_wallet_record,
        )?;

        positions::on_buy(receiver_record, amount, current_price)?;
        save_wallet_record(&ctx.accounts.receiver_wallet_record, receiver_record)?;

        msg!("Skye Ladder: BUY {} tokens at price {}", amount, current_price);
    } else if is_sell {
        // ── SELL: Wallet → Pool ──
        // Enforce unlock restrictions on the sender.
        let sender_record = &mut load_wallet_record_mut(
            &ctx.accounts.sender_wallet_record,
        )?;
        sanitize_corrupt_entry_prices(sender_record, current_price);
        positions::on_sell(sender_record, amount, current_price)?;
        save_wallet_record(&ctx.accounts.sender_wallet_record, sender_record)?;

        msg!("Skye Ladder: SELL {} tokens at price {}", amount, current_price);
    } else {
        // ── TRANSFER: Wallet → Wallet ──
        // Sender must pass unlock check (treated as sell).
        let sender_record = &mut load_wallet_record_mut(
            &ctx.accounts.sender_wallet_record,
        )?;
        sanitize_corrupt_entry_prices(sender_record, current_price);
        positions::on_sell(sender_record, amount, current_price)?;
        save_wallet_record(&ctx.accounts.sender_wallet_record, sender_record)?;

        // Receiver gets a new position at current spot price.
        let receiver_record = &mut load_wallet_record_mut(
            &ctx.accounts.receiver_wallet_record,
        )?;
        positions::on_buy(receiver_record, amount, current_price)?;
        save_wallet_record(&ctx.accounts.receiver_wallet_record, receiver_record)?;

        msg!("Skye Ladder: TRANSFER {} tokens at price {}", amount, current_price);
    }

    Ok(())
}

/// Fix positions with impossibly high entry_price caused by old merge bugs.
///
/// If a position's entry_price is >1000x the current spot price, it's corrupt
/// (no real position could be that far underwater). Reset entry_price to
/// current_price so the position is treated as "at entry" (Phase 1 unlock)
/// rather than getting 100% unlock via the underwater rule.
fn sanitize_corrupt_entry_prices(record: &mut WalletRecord, current_price: u64) {
    let cp = current_price as u128;
    for pos in record.positions.iter_mut() {
        if pos.entry_price == 0 || pos.token_balance == 0 {
            continue;
        }
        let ep = pos.entry_price as u128;
        // If entry_price > 1000x current price, it's corrupt
        if ep > cp.saturating_mul(1000) {
            msg!(
                "Skye Ladder: Fixing corrupt entry_price {} → {} for position with {} tokens",
                pos.entry_price, current_price, pos.token_balance
            );
            pos.entry_price = current_price;
            // Recalculate initial_sol from corrected entry price
            let new_initial = (pos.original_balance as u128)
                .saturating_mul(current_price as u128)
                / PRICE_SCALE;
            pos.initial_sol = new_initial as u64;
            // Reset unlock since the position is effectively "new"
            pos.unlocked_bps = 0;
        }
    }
}

/// Read the spot price from the Skye AMM Pool account.
///
/// Validates that the pool account matches the address stored in Config,
/// then delegates to the pool_price module for actual price computation.
fn read_spot_price(accounts: &TransferHook) -> Result<u64> {
    let config = &accounts.config;
    let lb_pair_info = &accounts.lb_pair;

    // Verify the pool account matches what's in Config and is owned by the AMM program
    require!(
        lb_pair_info.key() == config.lb_pair,
        SkyeLadderError::InvalidPool
    );
    // Pool must be owned by AMM or Curve program to prevent spoofed price data
    let amm_program_id = pubkey!("GRBvJRRJfV3CzRLocGcr3NTptWQpu1G4nW9Jpff5TFoX");
    let curve_program_id = pubkey!("5bxtpbYgiMQMJcB1c2cWXGErsiRmAZeyRqRKCXoeZRXf");
    require!(
        *lb_pair_info.owner == amm_program_id || *lb_pair_info.owner == curve_program_id,
        SkyeLadderError::InvalidPool
    );

    let pool_data = lb_pair_info.try_borrow_data()?;
    pool_price::read_spot_price_from_pool(&pool_data)
}

/// Deserialize a WalletRecord from an AccountInfo.
/// Returns a mutable owned copy for modification.
fn load_wallet_record_mut(account: &AccountInfo) -> Result<WalletRecord> {
    // If account has no data or is not initialized, return a default empty record
    if account.data_len() == 0 || account.owner == &anchor_lang::system_program::ID {
        return Ok(WalletRecord {
            owner: account.key(),
            mint: Pubkey::default(),
            position_count: 0,
            positions: vec![],
            last_buy_slot: 0,
            slot_buy_usd: 0,
            bump: 0,
        });
    }

    let data = account.try_borrow_data()?;
    if data.len() < 8 {
        return Ok(WalletRecord {
            owner: account.key(),
            mint: Pubkey::default(),
            position_count: 0,
            positions: vec![],
            last_buy_slot: 0,
            slot_buy_usd: 0,
            bump: 0,
        });
    }
    // Try to deserialize. If the layout changed (migration), return empty record.
    let mut slice: &[u8] = &data;
    match WalletRecord::try_deserialize(&mut slice) {
        Ok(record) => {
            // Sanity check: detect corrupt records from layout migration.
            // Total supply is 1B tokens = 10^18 raw. Any position with
            // token_balance > 10^18 is impossible and means garbled data.
            let max_raw: u64 = 1_000_000_000_000_000_000;
            // Max realistic entry_price: 1 SOL/token = 1e18 in PRICE_SCALE.
            // Anything above this is from a corrupt merge.
            let max_entry_price: u64 = PRICE_SCALE as u64; // 1 SOL per token
            let corrupt = record.positions.iter().any(|p| {
                p.token_balance > max_raw
                || p.original_balance > max_raw
                || p.entry_price == 0
                || p.entry_price > max_entry_price
                // Detect stale positions: original vastly exceeds balance (>100x)
                // means the original_balance tracking drifted from reality
                || (p.original_balance > 0 && p.token_balance > 0
                    && p.original_balance / p.token_balance.max(1) > 100)
            });
            if corrupt {
                // Filter out corrupt/stale positions, keep valid ones
                let clean: Vec<_> = record.positions.into_iter()
                    .filter(|p| {
                        p.token_balance <= max_raw
                        && p.original_balance <= max_raw
                        && p.entry_price > 0
                        && p.entry_price <= max_entry_price
                        && (p.original_balance == 0
                            || p.original_balance / p.token_balance.max(1) <= 100)
                    })
                    .collect();
                Ok(WalletRecord {
                    position_count: clean.len() as u8,
                    positions: clean,
                    ..record
                })
            } else {
                Ok(record)
            }
        },
        Err(_) => Ok(WalletRecord {
            owner: account.key(),
            mint: Pubkey::default(),
            position_count: 0,
            positions: vec![],
            last_buy_slot: 0,
            slot_buy_usd: 0,
            bump: 0,
        }),
    }
}

/// Serialize a WalletRecord back into its AccountInfo.
fn save_wallet_record(account: &AccountInfo, record: &WalletRecord) -> Result<()> {
    if account.owner == &anchor_lang::system_program::ID {
        return Ok(());
    }

    let mut data = account.try_borrow_mut_data()?;
    if data.len() < 8 {
        return Ok(());
    }
    // try_serialize includes the discriminator, so write from position 0
    let mut writer: &mut [u8] = &mut data;
    record.try_serialize(&mut writer)?;
    Ok(())
}

/// Accounts for the transfer hook execute instruction.
///
/// The first 5 accounts are mandated by the Token-2022 transfer hook interface:
///   0: source token account
///   1: mint
///   2: destination token account
///   3: source token account owner/delegate
///   4: extra_account_meta_list PDA
///
/// Additional accounts (from ExtraAccountMetaList):
///   5: config PDA
///   6: sender WalletRecord PDA
///   7: receiver WalletRecord PDA
///   8: AMM Pool account (for spot price)
#[derive(Accounts)]
pub struct TransferHook<'info> {
    /// Source token account (sender).
    /// CHECK: Validated by Token-2022 program.
    pub source_token: AccountInfo<'info>,

    /// The Token-2022 mint.
    pub mint: InterfaceAccount<'info, Mint>,

    /// Destination token account (receiver).
    /// CHECK: Validated by Token-2022 program.
    pub destination_token: AccountInfo<'info>,

    /// Source token account owner/delegate.
    /// CHECK: Validated by Token-2022 program.
    pub owner_delegate: AccountInfo<'info>,

    /// Extra account meta list PDA.
    /// CHECK: Validated by seeds.
    #[account(
        seeds = [b"extra-account-metas", mint.key().as_ref()],
        bump,
    )]
    pub extra_account_meta_list: AccountInfo<'info>,

    /// Config PDA.
    #[account(
        seeds = [b"config", mint.key().as_ref()],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    /// Sender's WalletRecord PDA.
    /// CHECK: May not exist yet (for new wallets). Validated by seeds in later steps.
    #[account(mut)]
    pub sender_wallet_record: AccountInfo<'info>,

    /// Receiver's WalletRecord PDA.
    /// CHECK: May not exist yet (for new wallets). Validated by seeds in later steps.
    #[account(mut)]
    pub receiver_wallet_record: AccountInfo<'info>,

    /// AMM Pool account (read-only, for spot price).
    /// CHECK: Validated against config.lb_pair in handler.
    pub lb_pair: AccountInfo<'info>,
}
