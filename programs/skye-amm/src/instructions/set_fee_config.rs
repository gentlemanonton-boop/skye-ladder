use anchor_lang::prelude::*;
use crate::errors::SkyeAmmError;
use crate::state::Pool;

/// Set the team wallet that receives 50% of every swap fee. The other 50%
/// stays in the pool reserves as LP yield.
///
/// The `team_wallet` is expected to be a WSOL token account owned by the
/// protocol treasury. Pass `Pubkey::default()` to disable fee collection
/// entirely (everything stays in the pool).
///
/// HISTORY: This handler used to take `diamond_vault` and `strong_vault`
/// pubkeys for a 4-way fee split (team / pool / diamond / strong). That
/// model was scrapped along with `claim_rewards`. We zero out the legacy
/// offsets here so older pools that had vaults configured stop trying to
/// route fees there. The Pool struct still owns those byte ranges for
/// account-layout compatibility — they're just dead state now.
pub fn handler(ctx: Context<SetFeeConfig>, team_wallet: Pubkey) -> Result<()> {
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

    // Pool layout:
    //   8 disc + 6*32 (pubkeys) + 16 (skye+wsol amounts) + 4 (fee_bps+bump+lp_bump) = 220
    //   team_wallet     [220..252]
    //   diamond_vault   [252..284]   ← legacy, zeroed
    //   strong_vault    [284..316]   ← legacy, zeroed
    {
        let mut data = pool_info.try_borrow_mut_data()?;
        data[220..252].copy_from_slice(&team_wallet.to_bytes());
        data[252..284].copy_from_slice(&[0u8; 32]);
        data[284..316].copy_from_slice(&[0u8; 32]);
    }

    msg!("Fee config: team={} (50/50 team/pool split)", team_wallet);
    Ok(())
}

#[derive(Accounts)]
pub struct SetFeeConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: Validated manually via authority check + owner verification
    #[account(mut, owner = crate::ID)]
    pub pool: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}
