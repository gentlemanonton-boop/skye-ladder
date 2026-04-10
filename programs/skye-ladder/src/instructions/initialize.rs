use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;
use spl_transfer_hook_interface::instruction::ExecuteInstruction;
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList,
};

use crate::state::Config;

/// Platform authority — the ONLY key that can admin hook configs (pause,
/// update_pool, update_extra_metas, transfer_authority). Hardcoded so that
/// token launchers cannot manipulate sell restrictions on their own tokens.
pub const PLATFORM_AUTHORITY: Pubkey = pubkey!("2gbiB89rcxffHPQBE35P42HTG45rJPHg7RgJ9jXfPXQW");

/// Initialize the Skye Ladder transfer hook: creates the Config PDA
/// and the ExtraAccountMetaList PDA required by Token-2022.
///
/// - `pool`: the DLMM pool's SKYE token reserve account (for buy/sell classification)
/// - `lb_pair`: the Meteora DLMM LbPair account (for reading spot price)
pub fn handler(ctx: Context<Initialize>, pool: Pubkey, lb_pair: Pubkey) -> Result<()> {
    // Store config
    let config = &mut ctx.accounts.config;
    // Always set to the hardcoded platform authority, NOT the launcher.
    // Prevents malicious launchers from pausing the hook or manipulating
    // buy/sell classification on their own tokens.
    config.authority = PLATFORM_AUTHORITY;
    config.mint = ctx.accounts.mint.key();
    config.pool = pool;
    config.lb_pair = lb_pair;
    config.paused = false;
    config.bump = ctx.bumps.config;

    // Build the extra account metas that Token-2022 will pass into execute.
    // We need:
    //   1. Config PDA (read-only)
    //   2. Sender WalletRecord PDA (writable)
    //   3. Receiver WalletRecord PDA (writable)
    //   4. LbPair account (read-only, for price reading)
    let extra_metas = vec![
        // Config PDA: seeds = [b"config", mint]
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: b"config".to_vec(),
                },
                Seed::AccountKey { index: 1 }, // mint is account index 1 in execute
            ],
            false, // is_signer
            false, // is_writable
        )?,
        // Sender WalletRecord PDA: seeds = [b"wallet", source_owner, mint]
        // Index 3 = owner/delegate of the source token account
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: b"wallet".to_vec(),
                },
                Seed::AccountKey { index: 3 }, // source owner/delegate
                Seed::AccountKey { index: 1 }, // mint
            ],
            false, // is_signer
            true,  // is_writable
        )?,
        // Receiver WalletRecord PDA: seeds = [b"wallet", dest_owner, mint]
        // Destination owner is extracted from the destination token account data.
        // Token account layout: [mint(32)][owner(32)]... — owner at offset 32.
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: b"wallet".to_vec(),
                },
                Seed::AccountData {
                    account_index: 2,  // destination token account
                    data_index: 32,    // owner field offset in token account
                    length: 32,        // pubkey = 32 bytes
                },
                Seed::AccountKey { index: 1 }, // mint
            ],
            false, // is_signer
            true,  // is_writable
        )?,
        // LbPair account: fixed address stored in Config
        ExtraAccountMeta::new_with_pubkey(
            &lb_pair,
            false, // is_signer
            false, // is_writable
        )?,
    ];

    // Write the extra account metas into the PDA
    let account_info = ctx.accounts.extra_account_meta_list.to_account_info();
    let mut data = account_info.try_borrow_mut_data()?;
    ExtraAccountMetaList::init::<ExecuteInstruction>(&mut data, &extra_metas)?;

    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// The Token-2022 mint with transfer hook extension pointing to this program.
    pub mint: InterfaceAccount<'info, Mint>,

    /// Config PDA: stores admin authority, pool address, etc.
    #[account(
        init,
        payer = authority,
        space = 8 + Config::INIT_SPACE,
        seeds = [b"config", mint.key().as_ref()],
        bump,
    )]
    pub config: Account<'info, Config>,

    /// Extra account meta list PDA required by Token-2022 transfer hook interface.
    /// Seeds are defined by spl-transfer-hook-interface.
    /// CHECK: Validated by seeds constraint; initialized in handler.
    #[account(
        init,
        payer = authority,
        space = ExtraAccountMetaList::size_of(4)?,
        seeds = [b"extra-account-metas", mint.key().as_ref()],
        bump,
    )]
    pub extra_account_meta_list: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}
