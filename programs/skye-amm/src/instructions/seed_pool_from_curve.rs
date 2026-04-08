use anchor_lang::prelude::*;
use anchor_spl::{
    token::Token,
    token_interface::{
        self, Mint as InterfaceMint, MintTo, TokenAccount as InterfaceTokenAccount,
    },
};

use crate::errors::SkyeAmmError;
use crate::math;
use crate::state::Pool;

/// Hardcoded curve program ID. The curve PDA derived from
/// `[b"curve", skye_mint]` under this program is the only signer authorized
/// to call `seed_pool_from_curve`.
pub const CURVE_PROGRAM_ID: Pubkey = pubkey!("5bxtpbYgiMQMJcB1c2cWXGErsiRmAZeyRqRKCXoeZRXf");

/// Solana incinerator address. Sending tokens here permanently locks them —
/// no key on Earth can move tokens out of this address. Used by graduation
/// to lock 100% of the LP supply, making the principal liquidity rugproof
/// in the same way pump.fun's bonded tokens are.
pub const INCINERATOR: Pubkey = pubkey!("1nc1nerator11111111111111111111111111111111");

/// Seed a freshly-initialized pool with reserves transferred from a
/// graduated bonding curve. Atomically:
///
///   1. Sets `pool.skye_amount` and `pool.wsol_amount` to the reserve totals
///      that the curve just transferred into the pool's reserve ATAs.
///   2. Computes `initial_lp = sqrt(skye * wsol)` (Uniswap V2 first-LP formula).
///   3. Mints `initial_lp` LP tokens to the Solana incinerator. The principal
///      liquidity is now permanently locked — only swap fees can be extracted.
///
/// Auth: only callable by the curve program, signing as the curve PDA derived
/// from `[b"curve", skye_mint]` under `CURVE_PROGRAM_ID`. Random callers
/// cannot pre-seed pools with manipulated reserve values.
///
/// One-shot: requires `lp_mint.supply == 0`. Calling twice fails because the
/// LP supply is non-zero after the first successful call.
pub fn handler(
    ctx: Context<SeedPoolFromCurve>,
    skye_amount: u64,
    wsol_amount: u64,
) -> Result<()> {
    require!(skye_amount > 0 && wsol_amount > 0, SkyeAmmError::ZeroAmount);

    // Reject if the pool was already seeded — this is a one-shot bootstrap.
    require!(
        ctx.accounts.lp_mint.supply == 0,
        SkyeAmmError::AlreadySeeded
    );

    // Reject if anyone has already called add_liquidity to mutate the cache.
    // This catches the case where a manual add_liquidity got there first.
    let pool_check = &ctx.accounts.pool;
    require!(
        pool_check.skye_amount == 0 && pool_check.wsol_amount == 0,
        SkyeAmmError::AlreadySeeded
    );

    // Uniswap V2 first-LP formula: sqrt(a * b)
    let initial_lp = math::compute_initial_lp(skye_amount, wsol_amount)?;
    require!(initial_lp > 0, SkyeAmmError::ZeroAmount);

    // Update cached reserves to match what the curve just transferred in.
    let pool = &mut ctx.accounts.pool;
    pool.skye_amount = skye_amount;
    pool.wsol_amount = wsol_amount;

    // Sign as the lp_authority PDA to mint LP tokens to the incinerator.
    let pool_key = pool.key();
    let lp_auth_seeds: &[&[u8]] = &[
        b"lp-authority",
        pool_key.as_ref(),
        &[pool.lp_authority_bump],
    ];

    token_interface::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.lp_mint.to_account_info(),
                to: ctx.accounts.incinerator_lp_account.to_account_info(),
                authority: ctx.accounts.lp_authority.to_account_info(),
            },
            &[lp_auth_seeds],
        ),
        initial_lp,
    )?;

    msg!(
        "SEEDED: {} SKYE + {} WSOL -> {} LP burned to incinerator (rugproof)",
        skye_amount,
        wsol_amount,
        initial_lp
    );

    Ok(())
}

#[derive(Accounts)]
pub struct SeedPoolFromCurve<'info> {
    /// Curve PDA. Must be a signer (the curve program signs as this PDA via
    /// `invoke_signed` when it calls into us). The seeds + seeds::program
    /// constraint pin this to the canonical curve PDA for `skye_mint`,
    /// preventing anyone else from impersonating it.
    #[account(
        seeds = [b"curve", skye_mint.key().as_ref()],
        seeds::program = CURVE_PROGRAM_ID,
        bump,
    )]
    pub curve_pda: Signer<'info>,

    /// SKYE Token-2022 mint.
    pub skye_mint: Box<InterfaceAccount<'info, InterfaceMint>>,

    /// WSOL mint.
    pub wsol_mint: Box<InterfaceAccount<'info, InterfaceMint>>,

    /// Target pool. The cached reserve amounts get updated in place.
    #[account(
        mut,
        seeds = [b"pool", skye_mint.key().as_ref(), wsol_mint.key().as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, Pool>>,

    /// LP token mint owned by `lp_authority`. Supply MUST be zero on entry.
    #[account(mut, constraint = lp_mint.key() == pool.lp_mint)]
    pub lp_mint: Box<InterfaceAccount<'info, InterfaceMint>>,

    /// LP token account owned by the Solana incinerator. The pre-stage
    /// script creates this ATA before graduation can happen. The token
    /// authority constraint pins it to INCINERATOR so a malicious caller
    /// can't redirect the burn into a recoverable account.
    #[account(
        mut,
        token::mint = lp_mint,
        token::authority = INCINERATOR,
    )]
    pub incinerator_lp_account: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,

    /// LP mint authority PDA — signs the mint_to CPI.
    /// CHECK: PDA used only as signing authority.
    #[account(
        seeds = [b"lp-authority", pool.key().as_ref()],
        bump = pool.lp_authority_bump,
    )]
    pub lp_authority: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
}
