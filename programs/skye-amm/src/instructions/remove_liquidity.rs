use anchor_lang::prelude::*;
use anchor_spl::{
    token::Token,
    token_2022::Token2022,
    token_interface::{
        self, Mint as InterfaceMint, TokenAccount as InterfaceTokenAccount,
        TransferChecked, Burn,
    },
};

use crate::errors::SkyeAmmError;
use crate::math;
use crate::state::Pool;
use super::add_liquidity::transfer_token2022_with_hook;

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, RemoveLiquidity<'info>>,
    lp_amount: u64,
    min_skye_out: u64,
    min_wsol_out: u64,
) -> Result<()> {
    require!(lp_amount > 0, SkyeAmmError::ZeroAmount);

    let pool = &ctx.accounts.pool;
    let lp_supply = ctx.accounts.lp_mint.supply;

    let (skye_out, wsol_out) = math::compute_withdraw(
        lp_amount,
        lp_supply,
        pool.skye_amount,
        pool.wsol_amount,
    )?;

    require!(skye_out >= min_skye_out, SkyeAmmError::SlippageExceeded);
    require!(wsol_out >= min_wsol_out, SkyeAmmError::SlippageExceeded);

    // Burn LP tokens
    token_interface::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.lp_mint.to_account_info(),
                from: ctx.accounts.user_lp_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        lp_amount,
    )?;

    // Transfer SKYE from reserve to user (Token-2022, pool PDA signs)
    let skye_mint_key = ctx.accounts.pool.skye_mint;
    let wsol_mint_key = ctx.accounts.pool.wsol_mint;
    let pool_seeds: &[&[u8]] = &[
        b"pool",
        skye_mint_key.as_ref(),
        wsol_mint_key.as_ref(),
        &[ctx.accounts.pool.bump],
    ];

    transfer_token2022_with_hook(
        &ctx.accounts.skye_reserve.to_account_info(),
        &ctx.accounts.skye_mint.to_account_info(),
        &ctx.accounts.user_skye_account.to_account_info(),
        &ctx.accounts.pool.to_account_info(),
        &ctx.accounts.token_2022_program.to_account_info(),
        ctx.remaining_accounts,
        skye_out,
        ctx.accounts.skye_mint.decimals,
        pool_seeds,
    )?;

    // Transfer WSOL from reserve to user (standard Token, pool PDA signs)
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.wsol_reserve.to_account_info(),
                mint: ctx.accounts.wsol_mint.to_account_info(),
                to: ctx.accounts.user_wsol_account.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            },
            &[pool_seeds],
        ),
        wsol_out,
        ctx.accounts.wsol_mint.decimals,
    )?;

    // Update cached reserves
    let pool = &mut ctx.accounts.pool;
    pool.skye_amount = pool.skye_amount.checked_sub(skye_out)
        .ok_or(SkyeAmmError::MathOverflow)?;
    pool.wsol_amount = pool.wsol_amount.checked_sub(wsol_out)
        .ok_or(SkyeAmmError::MathOverflow)?;

    msg!(
        "Removed liquidity: {} LP -> {} SKYE + {} WSOL",
        lp_amount, skye_out, wsol_out,
    );

    Ok(())
}

#[derive(Accounts)]
pub struct RemoveLiquidity<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool", pool.skye_mint.as_ref(), pool.wsol_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, Pool>>,

    pub skye_mint: Box<InterfaceAccount<'info, InterfaceMint>>,
    pub wsol_mint: Box<InterfaceAccount<'info, InterfaceMint>>,

    #[account(mut, token::mint = skye_mint)]
    pub user_skye_account: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,

    #[account(mut, token::mint = wsol_mint)]
    pub user_wsol_account: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,

    #[account(mut, constraint = skye_reserve.key() == pool.skye_reserve)]
    pub skye_reserve: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,

    #[account(mut, constraint = wsol_reserve.key() == pool.wsol_reserve)]
    pub wsol_reserve: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,

    #[account(mut, constraint = lp_mint.key() == pool.lp_mint)]
    pub lp_mint: Box<InterfaceAccount<'info, InterfaceMint>>,

    #[account(mut, token::mint = lp_mint, token::authority = user)]
    pub user_lp_account: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,

    pub token_2022_program: Program<'info, Token2022>,
    pub token_program: Program<'info, Token>,
}
