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
    let has_fee_config = pool.team_wallet != Pubkey::default()
        && pool.diamond_vault != Pubkey::default()
        && pool.strong_vault != Pubkey::default();

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

        // Split fee: 50% team, 25% pool, 17.5% diamond, 7.5% strong
        let (team_fee, _pool_fee, diamond_fee, strong_fee) = if has_fee_config && fee > 0 {
            math::split_fee(fee)
        } else {
            (0u64, fee, 0u64, 0u64)
        };

        // Update reserves — full amount_in minus team and vault shares enter pool
        let pool_receives = amount_in - team_fee - diamond_fee - strong_fee;
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

        // Transfer fees to diamond and strong vaults
        for (vault_fee, vault_key) in [(diamond_fee, ctx.accounts.pool.diamond_vault), (strong_fee, ctx.accounts.pool.strong_vault)] {
            if vault_fee > 0 {
                if let Some(vault_account) = ctx.remaining_accounts.iter().find(|a| a.is_writable && a.key() == vault_key) {
                    token_interface::transfer_checked(
                        CpiContext::new(ctx.accounts.token_program.to_account_info(), TransferChecked {
                            from: ctx.accounts.user_wsol_account.to_account_info(),
                            mint: ctx.accounts.wsol_mint.to_account_info(),
                            to: vault_account.clone(),
                            authority: ctx.accounts.user.to_account_info(),
                        }),
                        vault_fee,
                        ctx.accounts.wsol_mint.decimals,
                    )?;
                } else {
                    // Vault not provided — falls back to pool
                    token_interface::transfer_checked(
                        CpiContext::new(ctx.accounts.token_program.to_account_info(), TransferChecked {
                            from: ctx.accounts.user_wsol_account.to_account_info(),
                            mint: ctx.accounts.wsol_mint.to_account_info(),
                            to: ctx.accounts.wsol_reserve.to_account_info(),
                            authority: ctx.accounts.user.to_account_info(),
                        }),
                        vault_fee,
                        ctx.accounts.wsol_mint.decimals,
                    )?;
                    let pool = &mut ctx.accounts.pool;
                    pool.wsol_amount = pool.wsol_amount.checked_add(vault_fee)
                        .ok_or(SkyeAmmError::MathOverflow)?;
                }
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

        msg!("BUY: {} WSOL -> {} SKYE (fee: {} team, {} diamond, {} strong)", amount_in, skye_out, team_fee, diamond_fee, strong_fee);
    } else {
        // ── SELL: SKYE in, WSOL out ──
        let (wsol_out, fee) = math::compute_swap_output(
            pool.skye_amount, pool.wsol_amount, amount_in, fee_bps,
        )?;
        require!(wsol_out >= min_amount_out, SkyeAmmError::SlippageExceeded);

        // Fee is on the SKYE input side. But SKYE transfers trigger the hook.
        // Simpler: take fees from WSOL output instead (pool already has the WSOL).
        // Recompute: user gets wsol_out minus team and vault shares.
        let (team_fee, _pool_fee, diamond_fee, strong_fee) = if has_fee_config && fee > 0 {
            let wsol_fee = (wsol_out as u128) * (fee_bps as u128) / 10_000u128;
            math::split_fee(wsol_fee as u64)
        } else {
            (0u64, 0u64, 0u64, 0u64)
        };

        let user_receives = wsol_out - team_fee - diamond_fee - strong_fee;

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
            }
            // If team account not provided, fee stays in pool (wsol_out already deducted)
        }

        // Transfer vault fees from pool reserves
        for (vault_fee, vault_key) in [(diamond_fee, ctx.accounts.pool.diamond_vault), (strong_fee, ctx.accounts.pool.strong_vault)] {
            if vault_fee > 0 {
                if let Some(vault_account) = ctx.remaining_accounts.iter().find(|a| a.is_writable && a.key() == vault_key) {
                    token_interface::transfer_checked(
                        CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), TransferChecked {
                            from: ctx.accounts.wsol_reserve.to_account_info(),
                            mint: ctx.accounts.wsol_mint.to_account_info(),
                            to: vault_account.clone(),
                            authority: ctx.accounts.pool.to_account_info(),
                        }, &[pool_seeds]),
                        vault_fee,
                        ctx.accounts.wsol_mint.decimals,
                    )?;
                }
            }
        }

        msg!("SELL: {} SKYE -> {} WSOL (fee: {} team, {} diamond, {} strong)", amount_in, user_receives, team_fee, diamond_fee, strong_fee);
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
