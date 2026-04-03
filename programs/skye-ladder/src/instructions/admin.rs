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

/// Set the SOL/USD price used by anti-bundle limits.
/// Handles migration from old Config layout (without sol_price_usd) by
/// reallocating if needed, then writing the field at the correct offset.
pub fn set_sol_price(ctx: Context<SetSolPrice>, sol_price_usd: u64) -> Result<()> {
    let config_info = &ctx.accounts.config;

    // Verify authority (authority pubkey is at offset 8 in Config data)
    {
        let data = config_info.try_borrow_data()?;
        let stored_auth = Pubkey::try_from(&data[8..40])
            .map_err(|_| error!(SkyeLadderError::Unauthorized))?;
        require!(stored_auth == ctx.accounts.authority.key(), SkyeLadderError::Unauthorized);
    }

    let new_size = 8 + Config::INIT_SPACE;

    // Realloc if account is too small (migration from old layout)
    if config_info.data_len() < new_size {
        let rent = anchor_lang::prelude::Rent::get()?;
        let new_min = rent.minimum_balance(new_size);
        let current = config_info.lamports();
        if new_min > current {
            let diff = new_min - current;
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.authority.to_account_info(),
                        to: config_info.clone(),
                    },
                ),
                diff,
            )?;
        }
        config_info.realloc(new_size, false)?;
    }

    // Write sol_price_usd at the end of the Config data
    // Offset: 8 (disc) + 32*4 (pubkeys) + 1 (paused) + 1 (bump) = 138
    let sol_price_offset = 8 + 32 * 4 + 1 + 1;
    let mut data = config_info.try_borrow_mut_data()?;
    data[sol_price_offset..sol_price_offset + 8].copy_from_slice(&sol_price_usd.to_le_bytes());

    msg!("Skye Ladder: SOL price set to {} (USD x 10^6)", sol_price_usd);
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
pub struct SetSolPrice<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Manually validated via seeds and authority check in handler.
    /// Uses AccountInfo to support migration from old Config layout.
    #[account(
        mut,
        seeds = [b"config", mint.key().as_ref()],
        bump,
    )]
    pub config: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
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
