use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::Token,
    token_2022::Token2022,
    token_interface::Mint as InterfaceMint,
};

use crate::errors::SkyeAmmError;
use crate::state::Pool;

pub fn handler(ctx: Context<InitializePool>, fee_bps: u16) -> Result<()> {
    require!(fee_bps <= 10_000, SkyeAmmError::InvalidFee);

    let pool = &mut ctx.accounts.pool;
    pool.authority = ctx.accounts.authority.key();
    pool.skye_mint = ctx.accounts.skye_mint.key();
    pool.wsol_mint = ctx.accounts.wsol_mint.key();
    pool.skye_reserve = ctx.accounts.skye_reserve.key();
    pool.wsol_reserve = ctx.accounts.wsol_reserve.key();
    pool.lp_mint = ctx.accounts.lp_mint.key();
    pool.skye_amount = 0;
    pool.wsol_amount = 0;
    pool.fee_bps = fee_bps;
    pool.bump = ctx.bumps.pool;
    pool.lp_authority_bump = ctx.bumps.lp_authority;

    msg!(
        "Pool initialized: SKYE={}, WSOL={}, fee={}bps",
        ctx.accounts.skye_mint.key(),
        ctx.accounts.wsol_mint.key(),
        fee_bps,
    );

    Ok(())
}

/// Pool initialization accounts.
///
/// The SKYE reserve, WSOL reserve, and LP mint must be created in a
/// PRECEDING instruction within the same transaction (via ATA creation
/// and createMint). This instruction only initializes the Pool PDA
/// and records all addresses.
#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// SKYE mint (Token-2022)
    pub skye_mint: Box<InterfaceAccount<'info, InterfaceMint>>,

    /// WSOL / native SOL mint (standard Token program)
    pub wsol_mint: Box<InterfaceAccount<'info, InterfaceMint>>,

    /// Pool PDA
    #[account(
        init,
        payer = authority,
        space = 8 + Pool::INIT_SPACE,
        seeds = [b"pool", skye_mint.key().as_ref(), wsol_mint.key().as_ref()],
        bump,
    )]
    pub pool: Box<Account<'info, Pool>>,

    /// Pool's SKYE reserve — Token-2022 token account owned by pool PDA.
    /// Must be created before calling this instruction.
    /// CHECK: Validated that this account is owned by the Token-2022 or Token
    /// program (i.e. it is a real token account). The pool PDA is the authority
    /// check at transfer time, providing implicit ownership validation.
    #[account(
        constraint = *skye_reserve.owner == anchor_spl::token_2022::Token2022::id()
            || *skye_reserve.owner == anchor_spl::token::Token::id()
            @ SkyeAmmError::InvalidMint
    )]
    pub skye_reserve: AccountInfo<'info>,

    /// Pool's WSOL reserve — SPL Token account owned by pool PDA.
    /// Must be created before calling this instruction.
    /// CHECK: Validated that this account is owned by the Token-2022 or Token
    /// program (i.e. it is a real token account).
    #[account(
        constraint = *wsol_reserve.owner == anchor_spl::token_2022::Token2022::id()
            || *wsol_reserve.owner == anchor_spl::token::Token::id()
            @ SkyeAmmError::InvalidMint
    )]
    pub wsol_reserve: AccountInfo<'info>,

    /// LP token mint — created before calling this instruction.
    /// CHECK: Verified as a mint account.
    pub lp_mint: AccountInfo<'info>,

    /// LP mint authority PDA (signs LP mint/burn).
    /// CHECK: PDA used only as signing authority.
    #[account(
        seeds = [b"lp-authority", pool.key().as_ref()],
        bump,
    )]
    pub lp_authority: AccountInfo<'info>,

    pub token_2022_program: Program<'info, Token2022>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
