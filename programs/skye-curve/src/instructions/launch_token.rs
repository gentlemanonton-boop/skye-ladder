use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::Token,
    token_2022::Token2022,
    token_interface::Mint as InterfaceMint,
};

use crate::errors::SkyeCurveError;
use crate::math;
use crate::state::{Curve, LaunchpadConfig};

/// Launch a new token on the Skye bonding curve.
///
/// The caller must have already created the Token-2022 mint with:
/// - TransferHook extension pointing to the Skye Ladder program
/// - Minted total_supply to the creator's ATA
///
/// This instruction:
/// 1. Creates the Curve PDA
/// 2. Records the token reserve and SOL reserve account addresses
/// 3. Sets initial virtual reserves for the bonding curve
///
/// After calling this, the creator must:
/// - Initialize the Skye Ladder Config + ExtraAccountMetaList for this mint
/// - Transfer the total supply from their ATA to the curve's token_reserve
pub fn handler(
    ctx: Context<LaunchToken>,
    total_supply: u64,
    initial_virtual_sol: u64,
    fee_bps: u16,
) -> Result<()> {
    require!(total_supply > 0, SkyeCurveError::ZeroAmount);
    require!(initial_virtual_sol > 0, SkyeCurveError::ZeroAmount);
    require!(fee_bps <= 1000, SkyeCurveError::InvalidConfig); // max 10%

    let config = &ctx.accounts.launchpad_config;
    let (virtual_sol, virtual_token) = math::initial_virtual_reserves(total_supply, initial_virtual_sol);

    let curve = &mut ctx.accounts.curve;
    curve.creator = ctx.accounts.creator.key();
    curve.mint = ctx.accounts.mint.key();
    curve.wsol_mint = ctx.accounts.wsol_mint.key();
    curve.token_reserve = ctx.accounts.token_reserve.key();
    curve.sol_reserve = ctx.accounts.sol_reserve.key();
    curve.virtual_token_reserve = virtual_token;
    curve.virtual_sol_reserve = virtual_sol;
    curve.real_sol_reserve = 0;
    curve.real_token_reserve = total_supply;
    curve.total_supply = total_supply;
    curve.fee_bps = fee_bps;
    curve.graduated = false;
    curve.graduation_sol = config.default_graduation_sol;
    curve.bump = ctx.bumps.curve;
    curve.hook_program = config.hook_program;
    curve.creator_fee_wallet = ctx.accounts.creator.key();

    msg!(
        "Token launched: mint={}, supply={}, virtual_sol={}, virtual_token={}",
        ctx.accounts.mint.key(), total_supply, virtual_sol, virtual_token
    );

    Ok(())
}

#[derive(Accounts)]
pub struct LaunchToken<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    /// The Token-2022 mint (must already exist with TransferHook extension)
    pub mint: Box<InterfaceAccount<'info, InterfaceMint>>,

    /// WSOL mint
    pub wsol_mint: Box<InterfaceAccount<'info, InterfaceMint>>,

    /// Launchpad global config
    #[account(
        seeds = [b"launchpad-config"],
        bump = launchpad_config.bump,
    )]
    pub launchpad_config: Account<'info, LaunchpadConfig>,

    /// Curve PDA for this token
    #[account(
        init,
        payer = creator,
        space = 8 + Curve::INIT_SPACE,
        seeds = [b"curve", mint.key().as_ref()],
        bump,
    )]
    pub curve: Box<Account<'info, Curve>>,

    /// Token reserve — Token-2022 ATA owned by curve PDA
    /// CHECK: Will be created by the creator separately
    pub token_reserve: AccountInfo<'info>,

    /// SOL reserve — WSOL ATA owned by curve PDA
    /// CHECK: Will be created by the creator separately
    pub sol_reserve: AccountInfo<'info>,

    pub token_2022_program: Program<'info, Token2022>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
