use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

use crate::state::WalletRecord;

/// Create a WalletRecord PDA for a wallet.
/// Must be called before a wallet's first transfer (buy/sell/receive).
/// Anyone can call this and pay the rent — the record is owned by the program.
pub fn handler(ctx: Context<CreateWalletRecord>) -> Result<()> {
    let record = &mut ctx.accounts.wallet_record;
    record.owner = ctx.accounts.wallet.key();
    record.mint = ctx.accounts.mint.key();
    record.position_count = 0;
    record.positions = vec![];
    record.last_buy_slot = 0;
    record.slot_buy_usd = 0;
    record.bump = ctx.bumps.wallet_record;
    Ok(())
}

#[derive(Accounts)]
pub struct CreateWalletRecord<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The wallet this record is for (does not need to sign).
    /// CHECK: Any pubkey is valid — the record tracks positions for this wallet.
    pub wallet: AccountInfo<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = payer,
        space = 8 + WalletRecord::INIT_SPACE,
        seeds = [b"wallet", wallet.key().as_ref(), mint.key().as_ref()],
        bump,
    )]
    pub wallet_record: Account<'info, WalletRecord>,

    pub system_program: Program<'info, System>,
}
