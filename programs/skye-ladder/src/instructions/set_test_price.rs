use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

use crate::errors::SkyeLadderError;
use crate::state::Config;

/// Write test price data into the AMM Pool account.
/// Admin-only, for devnet/localnet testing.
/// Sets skye_amount and wsol_amount at the correct offsets so the
/// price reader can compute: price = wsol_amount * PRICE_SCALE / skye_amount.
///
/// SECURITY: Mainnet builds (default features) reject this instruction
/// unconditionally. Only `--features test-price` builds will execute it.
/// The discriminator still exists so the IDL is stable across build targets,
/// but the price-mutation attack surface is gone in production.
#[cfg(not(feature = "test-price"))]
pub fn handler(
    _ctx: Context<SetTestPrice>,
    _skye_amount: u64,
    _wsol_amount: u64,
) -> Result<()> {
    msg!("Skye Ladder: set_test_price disabled in this build");
    Err(SkyeLadderError::Unauthorized.into())
}

#[cfg(feature = "test-price")]
pub fn handler(
    ctx: Context<SetTestPrice>,
    skye_amount: u64,
    wsol_amount: u64,
) -> Result<()> {
    let config = &ctx.accounts.config;
    let lb_pair = &ctx.accounts.lb_pair;

    require!(
        lb_pair.key() == config.lb_pair,
        SkyeLadderError::InvalidPool
    );

    let mut data = lb_pair.try_borrow_mut_data()?;
    require!(data.len() >= 220, SkyeLadderError::InvalidPool);

    // Write fields at offsets matching pool_price.rs
    // skye_amount at offset 200, wsol_amount at offset 208
    data[200..208].copy_from_slice(&skye_amount.to_le_bytes());
    data[208..216].copy_from_slice(&wsol_amount.to_le_bytes());

    msg!(
        "Skye Ladder: Test price set — skye_amount={}, wsol_amount={}",
        skye_amount,
        wsol_amount,
    );

    Ok(())
}

#[derive(Accounts)]
pub struct SetTestPrice<'info> {
    #[account(
        constraint = authority.key() == config.authority @ SkyeLadderError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        seeds = [b"config", mint.key().as_ref()],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    /// The AMM Pool account to write test data to.
    /// Must match config.lb_pair.
    /// CHECK: Validated against config.lb_pair; data written in handler.
    #[account(mut)]
    pub lb_pair: AccountInfo<'info>,
}
