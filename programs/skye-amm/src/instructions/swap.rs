use anchor_lang::prelude::*;
use anchor_spl::{
    token::Token,
    token_2022::Token2022,
    token_interface::{
        self, Mint as InterfaceMint, TokenAccount as InterfaceTokenAccount,
        TransferChecked,
    },
};

use crate::errors::SkyeAmmError;
use crate::math;
use crate::state::Pool;
use super::add_liquidity::transfer_token2022_with_hook;

/// Byte offsets for cached reserves in the Pool account data.
/// Must match the Borsh layout: 8 (disc) + 6*32 (pubkeys) = 200.
const SKYE_AMOUNT_OFFSET: usize = 200;
const WSOL_AMOUNT_OFFSET: usize = 208;

/// Flush the updated skye_amount and wsol_amount to the Pool PDA's raw
/// account data BEFORE doing the Token-2022 CPI. This is necessary because
/// Anchor only serializes account data after the instruction handler returns,
/// but the transfer hook reads the Pool PDA's raw bytes during the CPI to
/// compute the spot price. Without this flush, the hook sees stale pre-swap
/// reserves and records the wrong entry_price.
fn flush_pool_reserves(pool: &Account<'_, Pool>) -> Result<()> {
    let info = pool.to_account_info();
    let mut data = info.try_borrow_mut_data()?;
    data[SKYE_AMOUNT_OFFSET..SKYE_AMOUNT_OFFSET + 8]
        .copy_from_slice(&pool.skye_amount.to_le_bytes());
    data[WSOL_AMOUNT_OFFSET..WSOL_AMOUNT_OFFSET + 8]
        .copy_from_slice(&pool.wsol_amount.to_le_bytes());
    Ok(())
}

/// Swap handler.
/// - `buy = true`:  user sends WSOL, receives SKYE (SOL -> SKYE)
/// - `buy = false`: user sends SKYE, receives WSOL (SKYE -> SOL)
pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, Swap<'info>>,
    amount_in: u64,
    min_amount_out: u64,
    buy: bool,
) -> Result<()> {
    require!(amount_in > 0, SkyeAmmError::ZeroAmount);

    let pool = &ctx.accounts.pool;
    let fee_bps = pool.fee_bps;

    if buy {
        // ── BUY: WSOL in, SKYE out ──
        let (skye_out, _fee) = math::compute_swap_output(
            pool.wsol_amount,
            pool.skye_amount,
            amount_in,
            fee_bps,
        )?;
        require!(skye_out >= min_amount_out, SkyeAmmError::SlippageExceeded);

        // Update reserves BEFORE transfers (checks-effects-interactions)
        let pool = &mut ctx.accounts.pool;
        pool.wsol_amount = pool.wsol_amount.checked_add(amount_in)
            .ok_or(SkyeAmmError::MathOverflow)?;
        pool.skye_amount = pool.skye_amount.checked_sub(skye_out)
            .ok_or(SkyeAmmError::MathOverflow)?;

        // Flush to raw account data so the hook reads post-swap price
        flush_pool_reserves(pool)?;

        // Transfer WSOL in (standard Token)
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.user_wsol_account.to_account_info(),
                    mint: ctx.accounts.wsol_mint.to_account_info(),
                    to: ctx.accounts.wsol_reserve.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount_in,
            ctx.accounts.wsol_mint.decimals,
        )?;

        // Transfer SKYE out (Token-2022, pool PDA signs — triggers hook as "buy")
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

        msg!("BUY: {} WSOL -> {} SKYE", amount_in, skye_out);
    } else {
        // ── SELL: SKYE in, WSOL out ──
        let (wsol_out, _fee) = math::compute_swap_output(
            pool.skye_amount,
            pool.wsol_amount,
            amount_in,
            fee_bps,
        )?;
        require!(wsol_out >= min_amount_out, SkyeAmmError::SlippageExceeded);

        // Update reserves BEFORE transfers
        let pool = &mut ctx.accounts.pool;
        pool.skye_amount = pool.skye_amount.checked_add(amount_in)
            .ok_or(SkyeAmmError::MathOverflow)?;
        pool.wsol_amount = pool.wsol_amount.checked_sub(wsol_out)
            .ok_or(SkyeAmmError::MathOverflow)?;

        // Flush to raw account data so the hook reads post-swap price
        flush_pool_reserves(pool)?;

        // Transfer SKYE in (Token-2022 — triggers hook as "sell", enforces unlock)
        transfer_token2022_with_hook(
            &ctx.accounts.user_skye_account.to_account_info(),
            &ctx.accounts.skye_mint.to_account_info(),
            &ctx.accounts.skye_reserve.to_account_info(),
            &ctx.accounts.user.to_account_info(),
            &ctx.accounts.token_2022_program.to_account_info(),
            ctx.remaining_accounts,
            amount_in,
            ctx.accounts.skye_mint.decimals,
            &[],
        )?;

        // Transfer WSOL out (standard Token, pool PDA signs)
        let skye_mint_key = ctx.accounts.pool.skye_mint;
        let wsol_mint_key = ctx.accounts.pool.wsol_mint;
        let pool_seeds: &[&[u8]] = &[
            b"pool",
            skye_mint_key.as_ref(),
            wsol_mint_key.as_ref(),
            &[ctx.accounts.pool.bump],
        ];

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

        msg!("SELL: {} SKYE -> {} WSOL", amount_in, wsol_out);
    }

    Ok(())
}

#[derive(Accounts)]
pub struct Swap<'info> {
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

    pub token_2022_program: Program<'info, Token2022>,
    pub token_program: Program<'info, Token>,
}
