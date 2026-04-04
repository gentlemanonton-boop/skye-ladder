use anchor_lang::prelude::*;

/// Bonding curve pool for a single token.
/// Price follows: price = VIRTUAL_SOL_RESERVE / VIRTUAL_TOKEN_RESERVE
/// As tokens are bought, token_reserve decreases and sol_reserve increases,
/// pushing price up along the curve.
///
/// Uses virtual reserves so the curve starts at a non-zero price
/// without requiring initial liquidity from the creator.
#[account]
#[derive(InitSpace)]
pub struct Curve {
    /// Token creator
    pub creator: Pubkey,
    /// Token-2022 mint (with TransferHook)
    pub mint: Pubkey,
    /// WSOL mint
    pub wsol_mint: Pubkey,
    /// Token reserve account (Token-2022 ATA owned by curve PDA)
    pub token_reserve: Pubkey,
    /// SOL reserve account (WSOL ATA owned by curve PDA)
    pub sol_reserve: Pubkey,
    /// Virtual token reserve — starts at total supply, decreases as bought
    pub virtual_token_reserve: u64,
    /// Virtual SOL reserve — starts at initial_virtual_sol, increases as bought
    pub virtual_sol_reserve: u64,
    /// Real SOL in the pool (actual lamports deposited)
    pub real_sol_reserve: u64,
    /// Real tokens remaining in the pool
    pub real_token_reserve: u64,
    /// Total token supply minted into the curve
    pub total_supply: u64,
    /// Fee in basis points (e.g. 100 = 1%)
    pub fee_bps: u16,
    /// Whether the curve has graduated (migrated to DEX)
    pub graduated: bool,
    /// Graduation threshold in SOL lamports (e.g. 85 SOL)
    pub graduation_sol: u64,
    /// PDA bump
    pub bump: u8,
    /// Skye Ladder program ID for the transfer hook
    pub hook_program: Pubkey,
    /// Creator fee wallet (receives creator's share of fees)
    pub creator_fee_wallet: Pubkey,
}

/// Global launchpad config — stores platform-wide settings
#[account]
#[derive(InitSpace)]
pub struct LaunchpadConfig {
    /// Platform authority
    pub authority: Pubkey,
    /// Platform fee wallet
    pub platform_fee_wallet: Pubkey,
    /// Platform fee in bps (taken from each swap, on top of curve fee)
    pub platform_fee_bps: u16,
    /// Skye Ladder program ID
    pub hook_program: Pubkey,
    /// Default graduation threshold in SOL
    pub default_graduation_sol: u64,
    /// Bump
    pub bump: u8,
}
