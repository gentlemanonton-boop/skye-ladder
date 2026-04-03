use anchor_lang::prelude::*;
use spl_transfer_hook_interface::instruction::TransferHookInstruction;

pub mod anti_bundle;
pub mod errors;
pub mod instructions;
pub mod math;
pub mod pool_price;
pub mod positions;
pub mod state;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod fuzz;

use instructions::*;

declare_id!("4THAwb6WSpDyyqMHnJL2VBjU7TCLfLLGC5jtuCiyX5Rz");

#[program]
pub mod skye_ladder {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, pool: Pubkey, lb_pair: Pubkey) -> Result<()> {
        instructions::initialize::handler(ctx, pool, lb_pair)
    }

    /// Transfer hook execute — called by Token-2022 on every transfer.
    /// The `#[interface]` attribute tells Anchor to route SPL Transfer Hook
    /// Execute calls (with the SPL discriminator) to this handler.
    #[interface(spl_transfer_hook_interface::execute)]
    pub fn transfer_hook(ctx: Context<TransferHook>, amount: u64) -> Result<()> {
        instructions::transfer_hook::handler(ctx, amount)
    }

    /// Create a WalletRecord PDA for a wallet. Must be called before first transfer.
    pub fn create_wallet_record(ctx: Context<CreateWalletRecord>) -> Result<()> {
        instructions::create_wallet_record::handler(ctx)
    }

    /// Write test price data to the AMM Pool account (admin only, for testing).
    pub fn set_test_price(ctx: Context<SetTestPrice>, skye_amount: u64, wsol_amount: u64) -> Result<()> {
        instructions::set_test_price::handler(ctx, skye_amount, wsol_amount)
    }

    pub fn update_pool(ctx: Context<AdminAction>, new_pool: Pubkey, new_lb_pair: Pubkey) -> Result<()> {
        instructions::admin::update_pool(ctx, new_pool, new_lb_pair)
    }

    pub fn update_extra_metas(ctx: Context<UpdateExtraMetas>) -> Result<()> {
        instructions::admin::update_extra_metas(ctx)
    }

    pub fn set_sol_price(ctx: Context<SetSolPrice>, sol_price_usd: u64) -> Result<()> {
        instructions::admin::set_sol_price(ctx, sol_price_usd)
    }

    pub fn set_paused(ctx: Context<AdminAction>, paused: bool) -> Result<()> {
        instructions::admin::set_paused(ctx, paused)
    }

    pub fn transfer_authority(ctx: Context<AdminAction>, new_authority: Pubkey) -> Result<()> {
        instructions::admin::transfer_authority(ctx, new_authority)
    }

    /// Fallback for unrecognized instructions — required by the SPL transfer
    /// hook interface. Routes TransferHookInstruction::Execute to our handler.
    pub fn fallback<'info>(
        program_id: &Pubkey,
        accounts: &'info [AccountInfo<'info>],
        data: &[u8],
    ) -> Result<()> {
        let instruction = TransferHookInstruction::unpack(data)?;

        match instruction {
            TransferHookInstruction::Execute { amount } => {
                let amount_bytes = amount.to_le_bytes();
                __private::__global::transfer_hook(program_id, accounts, &amount_bytes)
            }
            _ => Err(ProgramError::InvalidInstructionData.into()),
        }
    }
}
