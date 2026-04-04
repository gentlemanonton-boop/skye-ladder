use anchor_lang::prelude::*;
use anchor_spl::{
    token::Token,
    token_2022::Token2022,
    token_interface::{
        self, Mint as InterfaceMint, TokenAccount as InterfaceTokenAccount,
        TransferChecked,
    },
};
use solana_program::program::invoke_signed;

use crate::errors::SkyeCurveError;
use crate::state::Curve;

/// Graduate a bonding curve to a Skye AMM pool.
///
/// When real_sol_reserve >= graduation_sol, anyone can call this to:
/// 1. Transfer all remaining tokens from curve reserve → AMM pool token reserve
/// 2. Transfer all real SOL from curve reserve → AMM pool SOL reserve
/// 3. Call initialize_pool on the Skye AMM (if not already initialized)
/// 4. Mark the curve as graduated
///
/// After graduation, swaps on the curve are blocked. Users trade on the AMM.
///
/// Note: The AMM pool must be initialized separately before or during graduation.
/// This instruction handles the token/SOL transfer from curve → AMM reserves.
pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, Graduate<'info>>,
) -> Result<()> {
    let curve = &ctx.accounts.curve;

    // Must meet graduation threshold
    require!(
        curve.real_sol_reserve >= curve.graduation_sol,
        SkyeCurveError::InsufficientLiquidity
    );
    require!(!curve.graduated, SkyeCurveError::AlreadyGraduated);

    let mint_key = curve.mint;
    let curve_bump = curve.bump;
    let curve_seeds: &[&[u8]] = &[b"curve", mint_key.as_ref(), &[curve_bump]];

    let real_tokens = curve.real_token_reserve;
    let real_sol = curve.real_sol_reserve;

    // Transfer tokens from curve reserve → AMM token reserve
    // This is a Token-2022 transfer — triggers the hook
    // The hook is paused or the AMM reserve is whitelisted
    if real_tokens > 0 {
        let mut ix = spl_token_2022::instruction::transfer_checked(
            ctx.accounts.token_2022_program.key,
            &ctx.accounts.curve_token_reserve.key(),
            &ctx.accounts.mint.key(),
            &ctx.accounts.amm_token_reserve.key(),
            &ctx.accounts.curve.key(),
            &[],
            real_tokens,
            ctx.accounts.mint.decimals,
        )?;

        // Add hook extra accounts from remaining_accounts
        for account in ctx.remaining_accounts {
            ix.accounts.push(solana_program::instruction::AccountMeta {
                pubkey: *account.key,
                is_signer: account.is_signer,
                is_writable: account.is_writable,
            });
        }

        let mut account_infos = vec![
            ctx.accounts.curve_token_reserve.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.amm_token_reserve.to_account_info(),
            ctx.accounts.curve.to_account_info(),
        ];
        for account in ctx.remaining_accounts {
            account_infos.push(account.clone());
        }

        invoke_signed(&ix, &account_infos, &[curve_seeds])?;
    }

    // Transfer SOL from curve reserve → AMM SOL reserve (standard SPL Token, no hook)
    if real_sol > 0 {
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.curve_sol_reserve.to_account_info(),
                    mint: ctx.accounts.wsol_mint.to_account_info(),
                    to: ctx.accounts.amm_sol_reserve.to_account_info(),
                    authority: ctx.accounts.curve.to_account_info(),
                },
                &[curve_seeds],
            ),
            real_sol,
            ctx.accounts.wsol_mint.decimals,
        )?;
    }

    // Mark graduated
    let curve = &mut ctx.accounts.curve;
    curve.graduated = true;
    curve.real_sol_reserve = 0;
    curve.real_token_reserve = 0;

    msg!(
        "GRADUATED: {} tokens + {} SOL migrated to AMM pool",
        real_tokens, real_sol
    );

    Ok(())
}

#[derive(Accounts)]
pub struct Graduate<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"curve", curve.mint.as_ref()],
        bump = curve.bump,
        constraint = !curve.graduated @ SkyeCurveError::AlreadyGraduated,
    )]
    pub curve: Box<Account<'info, Curve>>,

    pub mint: Box<InterfaceAccount<'info, InterfaceMint>>,
    pub wsol_mint: Box<InterfaceAccount<'info, InterfaceMint>>,

    /// Curve's token reserve (source)
    #[account(mut, constraint = curve_token_reserve.key() == curve.token_reserve)]
    pub curve_token_reserve: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,

    /// Curve's SOL reserve (source)
    #[account(mut, constraint = curve_sol_reserve.key() == curve.sol_reserve)]
    pub curve_sol_reserve: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,

    /// AMM pool's token reserve (destination)
    #[account(mut)]
    pub amm_token_reserve: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,

    /// AMM pool's SOL reserve (destination)
    #[account(mut)]
    pub amm_sol_reserve: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,

    pub token_2022_program: Program<'info, Token2022>,
    pub token_program: Program<'info, Token>,
}
