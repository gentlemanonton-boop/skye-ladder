use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod math;
pub mod state;

use instructions::*;

declare_id!("GRBvJRRJfV3CzRLocGcr3NTptWQpu1G4nW9Jpff5TFoX");

#[program]
pub mod skye_amm {
    use super::*;

    pub fn initialize_pool(ctx: Context<InitializePool>, fee_bps: u16) -> Result<()> {
        instructions::initialize_pool::handler(ctx, fee_bps)
    }

    pub fn add_liquidity<'info>(
        ctx: Context<'_, '_, 'info, 'info, AddLiquidity<'info>>,
        skye_amount: u64,
        wsol_amount: u64,
        min_lp_tokens: u64,
    ) -> Result<()> {
        instructions::add_liquidity::handler(ctx, skye_amount, wsol_amount, min_lp_tokens)
    }

    pub fn remove_liquidity<'info>(
        ctx: Context<'_, '_, 'info, 'info, RemoveLiquidity<'info>>,
        lp_amount: u64,
        min_skye_out: u64,
        min_wsol_out: u64,
    ) -> Result<()> {
        instructions::remove_liquidity::handler(ctx, lp_amount, min_skye_out, min_wsol_out)
    }

    pub fn set_fee_config(ctx: Context<SetFeeConfig>, team_wallet: Pubkey, diamond_vault: Pubkey, strong_vault: Pubkey) -> Result<()> {
        instructions::set_fee_config::handler(ctx, team_wallet, diamond_vault, strong_vault)
    }

    pub fn swap<'info>(
        ctx: Context<'_, '_, 'info, 'info, Swap<'info>>,
        amount_in: u64,
        min_amount_out: u64,
        buy: bool,
    ) -> Result<()> {
        instructions::swap::handler(ctx, amount_in, min_amount_out, buy)
    }
}
