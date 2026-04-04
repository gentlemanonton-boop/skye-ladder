use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;
use anchor_spl::token::Token;
use anchor_spl::token_interface::{self, TokenAccount as InterfaceTokenAccount, TransferChecked};

use crate::errors::SkyeLadderError;
use crate::state::{Config, WalletRecord, PRICE_SCALE};

/// Skye AMM program ID — used to verify pool account ownership
const SKYE_AMM_ID: Pubkey = pubkey!("GRBvJRRJfV3CzRLocGcr3NTptWQpu1G4nW9Jpff5TFoX");

/// Claim rewards for a position that has reached 15x.
///
/// Qualification:
/// - Position multiplier >= 15x (fully unlocked)
/// - token_balance >= original_balance / 2 (held at least 50% of bag)
/// - Not already claimed
///
/// Reward tier:
/// - Diamond: sold_before_5x == false → claims from diamond_vault
/// - Strong: sold_before_5x == true → claims from strong_vault
/// - Under 50% bag → nothing (share stays in vault for others)
///
/// Reward amount = position_tokens / total_eligible_tokens * vault_balance
/// For simplicity in Phase 2, reward = vault_balance * position_tokens / pool_skye_amount
/// (approximation using pool supply as denominator)
pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, ClaimRewards<'info>>,
    position_index: u8,
) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(!config.paused, SkyeLadderError::Paused);

    let wallet_record = &mut ctx.accounts.wallet_record;
    let idx = position_index as usize;
    require!(idx < wallet_record.positions.len(), SkyeLadderError::ZeroTokens);

    let pos = &wallet_record.positions[idx];
    require!(!pos.is_empty(), SkyeLadderError::ZeroTokens);
    require!(!pos.claimed, SkyeLadderError::MathOverflow); // already claimed

    // Check 15x
    let current_price = read_pool_price(&ctx.accounts.pool_account)?;
    let mult = if pos.entry_price > 0 {
        (current_price as u128) * 10_000 / (pos.entry_price as u128)
    } else {
        0
    };
    require!(mult >= 150_000, SkyeLadderError::SellExceedsUnlocked); // not at 15x yet

    // Check 50% bag retention
    let original = if pos.original_balance >= pos.token_balance {
        pos.original_balance
    } else {
        pos.token_balance
    };
    let half = original / 2;
    require!(pos.token_balance >= half, SkyeLadderError::SellExceedsUnlocked); // under 50%

    // Determine tier and vault
    let is_diamond = !pos.sold_before_5x;

    // Calculate reward: proportional share of vault based on token balance
    // reward = vault_balance * pos.token_balance / total_supply_in_pool
    // Use the vault account balance directly
    let vault_balance = ctx.accounts.vault_token_account.amount;
    if vault_balance == 0 {
        // Nothing to claim but still mark as claimed
        let pos = &mut wallet_record.positions[idx];
        pos.claimed = true;
        msg!("Skye Ladder: Claimed (vault empty). Diamond={}", is_diamond);
        return Ok(());
    }

    // Simple proportional: reward = vault * position_tokens / pool_skye_amount
    let pool_skye = read_pool_skye(&ctx.accounts.pool_account)?;
    let reward = (vault_balance as u128)
        .checked_mul(pos.token_balance as u128)
        .ok_or(SkyeLadderError::MathOverflow)?
        .checked_div(pool_skye as u128)
        .ok_or(SkyeLadderError::MathOverflow)? as u64;

    let reward = reward.min(vault_balance); // can't exceed vault

    if reward > 0 {
        // Transfer WSOL from vault to claimer
        // The vault authority must sign — passed as remaining_accounts[0]
        require!(
            !ctx.remaining_accounts.is_empty(),
            SkyeLadderError::InvalidPool
        );
        let vault_authority = &ctx.remaining_accounts[0];
        require!(
            vault_authority.is_signer,
            SkyeLadderError::Unauthorized
        );
        // Verify the vault authority owns the vault token account
        require!(
            ctx.accounts.vault_token_account.owner == vault_authority.key(),
            SkyeLadderError::Unauthorized
        );

        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault_token_account.to_account_info(),
                    mint: ctx.accounts.wsol_mint.to_account_info(),
                    to: ctx.accounts.claimer_wsol_account.to_account_info(),
                    authority: vault_authority.clone(),
                },
            ),
            reward,
            ctx.accounts.wsol_mint.decimals,
        )?;
    }

    // Mark claimed
    let pos = &mut wallet_record.positions[idx];
    pos.claimed = true;

    msg!(
        "Skye Ladder: CLAIMED {} lamports. Diamond={}, mult={}",
        reward, is_diamond, mult / 10_000
    );

    Ok(())
}

fn read_pool_price(pool_data: &AccountInfo) -> Result<u64> {
    let data = pool_data.try_borrow_data()?;
    require!(data.len() >= 216, SkyeLadderError::InvalidPool);
    let skye = u64::from_le_bytes(data[200..208].try_into().map_err(|_| SkyeLadderError::InvalidPool)?);
    let wsol = u64::from_le_bytes(data[208..216].try_into().map_err(|_| SkyeLadderError::InvalidPool)?);
    require!(skye > 0 && wsol > 0, SkyeLadderError::ZeroPrice);
    Ok((wsol as u128 * PRICE_SCALE / skye as u128) as u64)
}

fn read_pool_skye(pool_data: &AccountInfo) -> Result<u64> {
    let data = pool_data.try_borrow_data()?;
    Ok(u64::from_le_bytes(data[200..208].try_into().map_err(|_| SkyeLadderError::InvalidPool)?))
}

#[derive(Accounts)]
pub struct ClaimRewards<'info> {
    #[account(mut)]
    pub claimer: Signer<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        seeds = [b"config", mint.key().as_ref()],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [b"wallet", claimer.key().as_ref(), mint.key().as_ref()],
        bump = wallet_record.bump,
    )]
    pub wallet_record: Account<'info, WalletRecord>,

    /// The AMM Pool account (for reading price)
    /// CHECK: Validated against config.lb_pair and AMM program ownership
    #[account(
        constraint = pool_account.key() == config.lb_pair @ SkyeLadderError::InvalidPool,
        owner = SKYE_AMM_ID,
    )]
    pub pool_account: AccountInfo<'info>,

    /// Vault token account (diamond or strong) to claim from
    #[account(mut)]
    pub vault_token_account: InterfaceAccount<'info, InterfaceTokenAccount>,

    /// Claimer's WSOL account to receive reward
    #[account(mut)]
    pub claimer_wsol_account: InterfaceAccount<'info, InterfaceTokenAccount>,

    /// WSOL mint
    pub wsol_mint: InterfaceAccount<'info, Mint>,

    pub token_program: Program<'info, Token>,
}
