use anchor_lang::prelude::*;
use crate::errors::SkyeAmmError;
use crate::state::Pool;

/// Set fee distribution addresses. Uses raw AccountInfo for migration.
pub fn handler(ctx: Context<SetFeeConfig>, team_wallet: Pubkey, diamond_vault: Pubkey, strong_vault: Pubkey) -> Result<()> {
    let pool_info = &ctx.accounts.pool;
    let new_size = 8 + Pool::INIT_SPACE;

    // Verify authority
    {
        let data = pool_info.try_borrow_data()?;
        let stored_auth = Pubkey::try_from(&data[8..40])
            .map_err(|_| error!(SkyeAmmError::InvalidMint))?;
        require!(stored_auth == ctx.accounts.authority.key(), SkyeAmmError::InvalidMint);
    }

    // Realloc if needed
    if pool_info.data_len() < new_size {
        let rent = Rent::get()?;
        let new_min = rent.minimum_balance(new_size);
        let current = pool_info.lamports();
        if new_min > current {
            let diff = new_min - current;
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.authority.to_account_info(),
                        to: pool_info.clone(),
                    },
                ),
                diff,
            )?;
        }
        pool_info.realloc(new_size, false)?;
    }

    // Write fields at correct offsets
    // Pool: 8(disc) + 6*32(192) + 8+8(16) + 2+1+1(4) = 220
    // team_wallet[220..252], diamond_vault[252..284], strong_vault[284..316]
    {
        let mut data = pool_info.try_borrow_mut_data()?;
        data[220..252].copy_from_slice(&team_wallet.to_bytes());
        data[252..284].copy_from_slice(&diamond_vault.to_bytes());
        data[284..316].copy_from_slice(&strong_vault.to_bytes());
    }

    msg!("Fee config: team={}, diamond={}, strong={}", team_wallet, diamond_vault, strong_vault);
    Ok(())
}

#[derive(Accounts)]
pub struct SetFeeConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: Validated manually via authority check
    #[account(mut)]
    pub pool: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}
