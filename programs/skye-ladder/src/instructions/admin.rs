use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;
use spl_transfer_hook_interface::instruction::ExecuteInstruction;
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList,
};

use crate::errors::SkyeLadderError;
use crate::state::Config;

/// Update the whitelisted pool address and LbPair.
pub fn update_pool(
    ctx: Context<AdminAction>,
    new_pool: Pubkey,
    new_lb_pair: Pubkey,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.pool = new_pool;
    config.lb_pair = new_lb_pair;
    msg!("Skye Ladder: Pool updated to {}, LbPair to {}", new_pool, new_lb_pair);
    Ok(())
}

/// Pause or unpause the transfer hook.
pub fn set_paused(ctx: Context<AdminAction>, paused: bool) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.paused = paused;
    msg!("Skye Ladder: Paused = {}", paused);
    Ok(())
}

/// Rewrite the ExtraAccountMetaList with the current config.lb_pair address.
/// Must be called after update_pool when changing the price source.
pub fn update_extra_metas(ctx: Context<UpdateExtraMetas>) -> Result<()> {
    let config = &ctx.accounts.config;

    let extra_metas = vec![
        // Config PDA: seeds = [b"config", mint]
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal { bytes: b"config".to_vec() },
                Seed::AccountKey { index: 1 },
            ],
            false, false,
        )?,
        // Sender WalletRecord PDA: seeds = [b"wallet", source_owner, mint]
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal { bytes: b"wallet".to_vec() },
                Seed::AccountKey { index: 3 },
                Seed::AccountKey { index: 1 },
            ],
            false, true,
        )?,
        // Receiver WalletRecord PDA: seeds = [b"wallet", dest_owner, mint]
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal { bytes: b"wallet".to_vec() },
                Seed::AccountData { account_index: 2, data_index: 32, length: 32 },
                Seed::AccountKey { index: 1 },
            ],
            false, true,
        )?,
        // AMM Pool account: fixed address from config
        ExtraAccountMeta::new_with_pubkey(&config.lb_pair, false, false)?,
    ];

    let account_info = ctx.accounts.extra_account_meta_list.to_account_info();
    let mut data = account_info.try_borrow_mut_data()?;
    ExtraAccountMetaList::update::<ExecuteInstruction>(&mut data, &extra_metas)?;

    msg!("Skye Ladder: ExtraAccountMetaList updated with lb_pair={}", config.lb_pair);
    Ok(())
}

/// Transfer admin authority to a new address.
pub fn transfer_authority(ctx: Context<AdminAction>, new_authority: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.authority = new_authority;
    msg!("Skye Ladder: Authority transferred to {}", new_authority);
    Ok(())
}

#[derive(Accounts)]
pub struct UpdateExtraMetas<'info> {
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

    /// CHECK: Validated by seeds; data rewritten in handler.
    #[account(
        mut,
        seeds = [b"extra-account-metas", mint.key().as_ref()],
        bump,
    )]
    pub extra_account_meta_list: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct AdminAction<'info> {
    #[account(
        constraint = authority.key() == config.authority @ SkyeLadderError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [b"config", mint.key().as_ref()],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,
}
