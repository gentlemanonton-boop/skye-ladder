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

const SKYE_AMOUNT_OFFSET: usize = 200;
const WSOL_AMOUNT_OFFSET: usize = 208;

fn flush_pool_reserves(pool: &Account<'_, Pool>) -> Result<()> {
    let info = pool.to_account_info();
    let mut data = info.try_borrow_mut_data()?;
    data[SKYE_AMOUNT_OFFSET..SKYE_AMOUNT_OFFSET + 8]
        .copy_from_slice(&pool.skye_amount.to_le_bytes());
    data[WSOL_AMOUNT_OFFSET..WSOL_AMOUNT_OFFSET + 8]
        .copy_from_slice(&pool.wsol_amount.to_le_bytes());
    Ok(())
}

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, Swap<'info>>,
    amount_in: u64,
    min_amount_out: u64,
    buy: bool,
) -> Result<()> {
    require!(amount_in > 0, SkyeAmmError::ZeroAmount);

    let pool = &ctx.accounts.pool;
    let fee_bps = pool.fee_bps;
    // The diamond/strong vault fields on Pool are dead state (kept for layout
    // compatibility with already-deployed pools). The only thing that matters
    // for the fee split now is whether team_wallet is configured.
    let has_team_wallet = pool.team_wallet != Pubkey::default();

    let skye_mint_key = pool.skye_mint;
    let wsol_mint_key = pool.wsol_mint;
    let pool_bump = pool.bump;

    let pool_seeds: &[&[u8]] = &[
        b"pool",
        skye_mint_key.as_ref(),
        wsol_mint_key.as_ref(),
        &[pool_bump],
    ];

    if buy {
        // ── BUY: WSOL in, SKYE out ──
        let (skye_out, fee) = math::compute_swap_output(
            pool.wsol_amount, pool.skye_amount, amount_in, fee_bps,
        )?;
        require!(skye_out >= min_amount_out, SkyeAmmError::SlippageExceeded);

        // Split fee: 50% team (treasury), 50% pool (LP).
        // If no team wallet is configured, the entire fee stays in the pool.
        let team_fee = if has_team_wallet && fee > 0 {
            math::split_fee(fee).0
        } else {
            0u64
        };

        // Reserves receive everything except the team's share.
        let pool_receives = amount_in
            .checked_sub(team_fee).ok_or(SkyeAmmError::MathOverflow)?;
        let pool = &mut ctx.accounts.pool;
        pool.wsol_amount = pool.wsol_amount.checked_add(pool_receives)
            .ok_or(SkyeAmmError::MathOverflow)?;
        pool.skye_amount = pool.skye_amount.checked_sub(skye_out)
            .ok_or(SkyeAmmError::MathOverflow)?;

        flush_pool_reserves(pool)?;

        // Transfer WSOL in: pool's share to reserve
        token_interface::transfer_checked(
            CpiContext::new(ctx.accounts.token_program.to_account_info(), TransferChecked {
                from: ctx.accounts.user_wsol_account.to_account_info(),
                mint: ctx.accounts.wsol_mint.to_account_info(),
                to: ctx.accounts.wsol_reserve.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            }),
            pool_receives,
            ctx.accounts.wsol_mint.decimals,
        )?;

        // Transfer WSOL fee to team wallet
        if team_fee > 0 {
            if let Some(team_account) = ctx.remaining_accounts.iter().find(|a| a.is_writable && a.key() == ctx.accounts.pool.team_wallet) {
                // Team wallet is a WSOL token account passed in remaining_accounts
                token_interface::transfer_checked(
                    CpiContext::new(ctx.accounts.token_program.to_account_info(), TransferChecked {
                        from: ctx.accounts.user_wsol_account.to_account_info(),
                        mint: ctx.accounts.wsol_mint.to_account_info(),
                        to: team_account.clone(),
                        authority: ctx.accounts.user.to_account_info(),
                    }),
                    team_fee,
                    ctx.accounts.wsol_mint.decimals,
                )?;
            } else {
                // Team account not provided — send to pool instead
                token_interface::transfer_checked(
                    CpiContext::new(ctx.accounts.token_program.to_account_info(), TransferChecked {
                        from: ctx.accounts.user_wsol_account.to_account_info(),
                        mint: ctx.accounts.wsol_mint.to_account_info(),
                        to: ctx.accounts.wsol_reserve.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                    }),
                    team_fee,
                    ctx.accounts.wsol_mint.decimals,
                )?;
                let pool = &mut ctx.accounts.pool;
                pool.wsol_amount = pool.wsol_amount.checked_add(team_fee)
                    .ok_or(SkyeAmmError::MathOverflow)?;
            }
        }

        // Transfer SKYE out (Token-2022, triggers hook as "buy")
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

        msg!("BUY: {} WSOL -> {} SKYE (team fee: {})", amount_in, skye_out, team_fee);
    } else {
        // ── SELL: SKYE in, WSOL out ──
        let (wsol_out, fee) = math::compute_swap_output(
            pool.skye_amount, pool.wsol_amount, amount_in, fee_bps,
        )?;
        require!(wsol_out >= min_amount_out, SkyeAmmError::SlippageExceeded);

        // Fee was already deducted from the SKYE input by compute_swap_output.
        // The `fee` value is in SKYE terms. Convert the team's 50% share to
        // WSOL using the pre-trade price ratio (reserve_out / reserve_in).
        //
        // Previous bug: applied fee_bps to wsol_out a SECOND time, effectively
        // charging sellers ~2% instead of 1% at 100 bps.
        let team_fee = if has_team_wallet && fee > 0 {
            let team_skye = math::split_fee(fee).0; // 50% of fee in SKYE terms
            // Convert SKYE fee to WSOL equivalent using pre-trade reserves
            let team_wsol = (team_skye as u128)
                .checked_mul(pool.wsol_amount as u128)
                .ok_or(SkyeAmmError::MathOverflow)?
                / (pool.skye_amount as u128);
            u64::try_from(team_wsol).map_err(|_| error!(SkyeAmmError::MathOverflow))?
        } else {
            0u64
        };

        let user_receives = wsol_out
            .checked_sub(team_fee).ok_or(SkyeAmmError::MathOverflow)?;

        // Update reserves
        let pool = &mut ctx.accounts.pool;
        pool.skye_amount = pool.skye_amount.checked_add(amount_in)
            .ok_or(SkyeAmmError::MathOverflow)?;
        pool.wsol_amount = pool.wsol_amount.checked_sub(wsol_out)
            .ok_or(SkyeAmmError::MathOverflow)?;

        flush_pool_reserves(pool)?;

        // Transfer SKYE in (Token-2022 — triggers hook as "sell")
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

        // Transfer WSOL out: user's portion
        token_interface::transfer_checked(
            CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), TransferChecked {
                from: ctx.accounts.wsol_reserve.to_account_info(),
                mint: ctx.accounts.wsol_mint.to_account_info(),
                to: ctx.accounts.user_wsol_account.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            }, &[pool_seeds]),
            user_receives,
            ctx.accounts.wsol_mint.decimals,
        )?;

        // Transfer team fee from pool reserves
        if team_fee > 0 {
            if let Some(team_account) = ctx.remaining_accounts.iter().find(|a| a.is_writable && a.key() == ctx.accounts.pool.team_wallet) {
                token_interface::transfer_checked(
                    CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), TransferChecked {
                        from: ctx.accounts.wsol_reserve.to_account_info(),
                        mint: ctx.accounts.wsol_mint.to_account_info(),
                        to: team_account.clone(),
                        authority: ctx.accounts.pool.to_account_info(),
                    }, &[pool_seeds]),
                    team_fee,
                    ctx.accounts.wsol_mint.decimals,
                )?;
            } else {
                // Team account not provided — WSOL stays in pool reserve.
                // Add team_fee back to cached wsol_amount to keep it in sync
                // with the actual reserve balance.
                let pool = &mut ctx.accounts.pool;
                pool.wsol_amount = pool.wsol_amount.checked_add(team_fee)
                    .ok_or(SkyeAmmError::MathOverflow)?;
            }
        }

        msg!("SELL: {} SKYE -> {} WSOL (team fee: {})", amount_in, user_receives, team_fee);
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
