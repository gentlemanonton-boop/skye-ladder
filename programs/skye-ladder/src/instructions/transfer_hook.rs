use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

use crate::anti_bundle;
use crate::errors::SkyeLadderError;
use crate::pool_price;
use crate::positions;
use crate::state::{Config, WalletRecord};

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

        // Anti-bundle: enforce per-block buy limits at low MC
        let buy_usd = anti_bundle::tokens_to_usd(amount, current_price, config.sol_price_usd)?;
        let clock = Clock::get()?;
        anti_bundle::enforce_buy_limit(
            receiver_record,
            buy_usd,
            current_price,
            config.sol_price_usd,
            clock.slot,
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
        positions::on_sell(sender_record, amount, current_price)?;
        save_wallet_record(&ctx.accounts.sender_wallet_record, sender_record)?;

        msg!("Skye Ladder: SELL {} tokens at price {}", amount, current_price);
    } else {
        // ── TRANSFER: Wallet → Wallet ──
        // Sender must pass unlock check (treated as sell).
        let sender_record = &mut load_wallet_record_mut(
            &ctx.accounts.sender_wallet_record,
        )?;
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

/// Read the spot price from the Skye AMM Pool account.
///
/// Validates that the pool account matches the address stored in Config,
/// then delegates to the pool_price module for actual price computation.
fn read_spot_price(accounts: &TransferHook) -> Result<u64> {
    let config = &accounts.config;
    let lb_pair_info = &accounts.lb_pair;

    // Verify the pool account matches what's in Config
    require!(
        lb_pair_info.key() == config.lb_pair,
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
    // Pass full data including 8-byte discriminator to try_deserialize
    let mut slice: &[u8] = &data;
    WalletRecord::try_deserialize(&mut slice)
        .map_err(|_| error!(SkyeLadderError::MathOverflow))
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
