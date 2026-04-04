use anchor_lang::prelude::*;
use crate::state::LaunchpadConfig;

pub fn handler(
    ctx: Context<InitLaunchpad>,
    platform_fee_bps: u16,
    hook_program: Pubkey,
    default_graduation_sol: u64,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.authority = ctx.accounts.authority.key();
    config.platform_fee_wallet = ctx.accounts.authority.key();
    config.platform_fee_bps = platform_fee_bps;
    config.hook_program = hook_program;
    config.default_graduation_sol = default_graduation_sol;
    config.bump = ctx.bumps.config;

    msg!("Launchpad initialized: hook={}, graduation={}",
        hook_program, default_graduation_sol);
    Ok(())
}

#[derive(Accounts)]
pub struct InitLaunchpad<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + LaunchpadConfig::INIT_SPACE,
        seeds = [b"launchpad-config"],
        bump,
    )]
    pub config: Account<'info, LaunchpadConfig>,

    pub system_program: Program<'info, System>,
}
