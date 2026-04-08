use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;
use anchor_spl::token::Token;
use anchor_spl::token_interface::TokenAccount as InterfaceTokenAccount;

use crate::errors::SkyeLadderError;
use crate::state::{Config, WalletRecord};

/// Skye AMM program ID — kept for the `pool_account` constraint below so the
/// IDL still validates the same accounts even though the handler no longer
/// uses them.
const SKYE_AMM_ID: Pubkey = pubkey!("GRBvJRRJfV3CzRLocGcr3NTptWQpu1G4nW9Jpff5TFoX");

/// SCRAPPED FEATURE — claim_rewards is permanently disabled.
///
/// The old design had two separate fee buckets on the AMM (`diamond_vault`
/// and `strong_vault`) that holders could draw from based on whether they
/// sold before the 5× milestone and whether they kept ≥50% of their bag.
/// That entire incentive system was scrapped by the protocol team — fees
/// now flow 50/50 between the treasury and the LP pool, period.
///
/// The instruction discriminator stays in the IDL so older clients don't
/// crash on enum mismatch, but invoking it always returns `Unauthorized`.
/// The on-disk `Position::sold_before_5x` and `Position::claimed` fields are
/// untouched (they remain as dead bytes for layout compatibility with the
/// 41 live mainnet WalletRecords), and `positions::on_sell` still writes to
/// `sold_before_5x` so the on-disk format stays consistent across upgrades.
pub fn handler<'info>(
    _ctx: Context<'_, '_, 'info, 'info, ClaimRewards<'info>>,
    _position_index: u8,
) -> Result<()> {
    msg!("Skye Ladder: claim_rewards has been permanently disabled");
    Err(SkyeLadderError::Unauthorized.into())
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

    /// The AMM Pool account (legacy account, no longer read).
    /// CHECK: Kept for IDL stability with older clients. Constraint preserved.
    #[account(
        constraint = pool_account.key() == config.lb_pair @ SkyeLadderError::InvalidPool,
        owner = SKYE_AMM_ID,
    )]
    pub pool_account: AccountInfo<'info>,

    /// Legacy vault token account (no longer used).
    #[account(mut)]
    pub vault_token_account: InterfaceAccount<'info, InterfaceTokenAccount>,

    /// Legacy claimer WSOL account (no longer used).
    #[account(mut)]
    pub claimer_wsol_account: InterfaceAccount<'info, InterfaceTokenAccount>,

    /// WSOL mint (legacy).
    pub wsol_mint: InterfaceAccount<'info, Mint>,

    pub token_program: Program<'info, Token>,
}
