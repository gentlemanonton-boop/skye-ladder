use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod math;
pub mod state;

use instructions::*;

declare_id!("5bxtpbYgiMQMJcB1c2cWXGErsiRmAZeyRqRKCXoeZRXf");

#[program]
pub mod skye_curve {
    use super::*;

    /// Initialize the launchpad global config (one-time, by platform authority)
    pub fn init_launchpad(
        ctx: Context<InitLaunchpad>,
        platform_fee_bps: u16,
        hook_program: Pubkey,
        default_graduation_sol: u64,
    ) -> Result<()> {
        instructions::init_launchpad::handler(ctx, platform_fee_bps, hook_program, default_graduation_sol)
    }

    /// Launch a new token with a bonding curve
    pub fn launch_token(
        ctx: Context<LaunchToken>,
        total_supply: u64,
        initial_virtual_sol: u64,
        fee_bps: u16,
    ) -> Result<()> {
        instructions::launch_token::handler(ctx, total_supply, initial_virtual_sol, fee_bps)
    }

    /// Graduate: migrate curve liquidity to Skye AMM pool
    pub fn graduate<'info>(
        ctx: Context<'_, '_, 'info, 'info, Graduate<'info>>,
    ) -> Result<()> {
        instructions::graduate::handler(ctx)
    }

    /// Swap on the bonding curve (buy or sell)
    pub fn swap<'info>(
        ctx: Context<'_, '_, 'info, 'info, SwapCurve<'info>>,
        amount: u64,
        min_out: u64,
        buy: bool,
    ) -> Result<()> {
        instructions::swap::handler(ctx, amount, min_out, buy)
    }
}
