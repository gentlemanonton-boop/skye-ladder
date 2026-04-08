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

use skye_amm::cpi::accounts::SeedPoolFromCurve as AmmSeedAccounts;
use skye_amm::cpi::seed_pool_from_curve as amm_seed_pool_from_curve;
use skye_amm::program::SkyeAmm;

/// Graduate a bonding curve into a Skye AMM pool — atomically.
///
/// When `real_sol_reserve >= graduation_sol`, anyone (or any backend
/// relayer) can call this single instruction to:
///   1. Transfer all remaining tokens from the curve reserve → AMM pool
///      token reserve (Token-2022 transfer that triggers the hook).
///   2. Transfer all real SOL from the curve reserve → AMM pool SOL reserve.
///   3. CPI into AMM `seed_pool_from_curve(real_tokens, real_sol)` which
///      sets the pool's cached reserves AND mints sqrt(skye*wsol) LP tokens
///      directly to the Solana incinerator. The principal liquidity is
///      now permanently locked, in the same rugproof model pump.fun uses.
///   4. Zeros the curve's tracked reserves and flips `graduated = true`.
///
/// After this instruction succeeds, swaps on the curve are blocked
/// (`AlreadyGraduated`) and trading happens exclusively on the AMM.
///
/// PREREQUISITE: the AMM Pool, lp_mint, reserves, and incinerator LP ATA
/// must already be initialized (one-time pre-stage). The pre-stage script
/// also calls AMM `set_fee_config(team_wallet=treasury_wsol_ata)` so that
/// the moment graduation completes, fees flow to the treasury automatically.
///
/// PERMISSIONLESS: anyone can call this. Pump.fun runs a relayer bot to
/// race-call it the moment threshold crosses; we'll do the same to make
/// graduation feel instant. Without a relayer, the next user to interact
/// with the curve (or the website itself) triggers it.
pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, Graduate<'info>>,
) -> Result<()> {
    let curve = &ctx.accounts.curve;

    // Must meet graduation threshold AND not already migrated.
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

    // ── Step 1: Transfer remaining tokens curve → AMM reserve ──
    // Token-2022 transfer with hook account forwarding via remaining_accounts.
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

    // ── Step 2: Transfer real SOL curve → AMM reserve ──
    // Standard SPL Token (no hook), curve PDA signs.
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

    // ── Step 3: CPI into AMM seed_pool_from_curve ──
    // This atomically (a) updates the pool's cached skye_amount/wsol_amount
    // to match the freshly transferred reserves, (b) mints sqrt(skye*wsol)
    // LP tokens to the incinerator, and (c) makes the pool tradeable.
    //
    // The curve PDA signs as the auth for the AMM's `curve_pda` Signer
    // constraint. The AMM verifies this is the canonical curve PDA derived
    // from [b"curve", skye_mint] under the hardcoded curve program ID.
    let cpi_accounts = AmmSeedAccounts {
        curve_pda: ctx.accounts.curve.to_account_info(),
        skye_mint: ctx.accounts.mint.to_account_info(),
        wsol_mint: ctx.accounts.wsol_mint.to_account_info(),
        pool: ctx.accounts.amm_pool.to_account_info(),
        lp_mint: ctx.accounts.lp_mint.to_account_info(),
        incinerator_lp_account: ctx.accounts.incinerator_lp_account.to_account_info(),
        lp_authority: ctx.accounts.lp_authority.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
    };

    // Bind to a let so the temporary outer slice outlives the CPI call.
    let signer_seeds: &[&[&[u8]]] = &[curve_seeds];
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.amm_program.to_account_info(),
        cpi_accounts,
        signer_seeds,
    );

    amm_seed_pool_from_curve(cpi_ctx, real_tokens, real_sol)?;

    // ── Step 4: Mark graduated, zero tracked reserves ──
    let curve = &mut ctx.accounts.curve;
    curve.graduated = true;
    curve.real_sol_reserve = 0;
    curve.real_token_reserve = 0;

    msg!(
        "GRADUATED: {} tokens + {} SOL migrated to AMM, LP burned to incinerator",
        real_tokens, real_sol
    );

    Ok(())
}

#[derive(Accounts)]
pub struct Graduate<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Curve PDA. NOTE: the previous `!curve.graduated` constraint was
    /// removed — without that removal the swap-time auto-flip used to lock
    /// graduate.rs out forever. The handler now does the same check
    /// internally, plus sets `graduated = true` only at the END once
    /// migration is complete.
    #[account(
        mut,
        seeds = [b"curve", curve.mint.as_ref()],
        bump = curve.bump,
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

    /// AMM pool's token reserve (destination). Must equal pool.skye_reserve;
    /// validated inside the seed_pool_from_curve CPI by the pool's seeds.
    #[account(mut)]
    pub amm_token_reserve: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,

    /// AMM pool's SOL reserve (destination).
    #[account(mut)]
    pub amm_sol_reserve: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,

    // ── AMM accounts for the seed CPI ──

    /// AMM Pool PDA. Validated inside the CPI handler by the pool seeds.
    /// CHECK: validated by AMM via seeds = [b"pool", skye_mint, wsol_mint].
    #[account(mut)]
    pub amm_pool: AccountInfo<'info>,

    /// AMM LP token mint (must have supply == 0 — one-shot bootstrap).
    #[account(mut)]
    pub lp_mint: Box<InterfaceAccount<'info, InterfaceMint>>,

    /// LP token ATA owned by the Solana incinerator. Must be created by the
    /// pre-stage script. Validated inside the CPI by token::authority constraint.
    #[account(mut)]
    pub incinerator_lp_account: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,

    /// LP mint authority PDA on the AMM side (signs the mint_to inside the CPI).
    /// CHECK: PDA derived from [b"lp-authority", pool] under the AMM program;
    /// validated by the seed_pool_from_curve handler.
    pub lp_authority: AccountInfo<'info>,

    /// The Skye AMM program — target of the seed_pool_from_curve CPI.
    pub amm_program: Program<'info, SkyeAmm>,

    pub token_2022_program: Program<'info, Token2022>,
    pub token_program: Program<'info, Token>,
}
