use anchor_lang::prelude::*;

/// Constant-product AMM pool for SKYE (Token-2022) / WSOL.
#[account]
#[derive(InitSpace)]
pub struct Pool {
    /// Admin authority
    pub authority: Pubkey,
    /// SKYE mint (Token-2022 with TransferHook)
    pub skye_mint: Pubkey,
    /// WSOL mint (native SOL mint)
    pub wsol_mint: Pubkey,
    /// Token-2022 account holding SKYE reserves
    pub skye_reserve: Pubkey,
    /// SPL Token account holding WSOL reserves
    pub wsol_reserve: Pubkey,
    /// LP token mint
    pub lp_mint: Pubkey,
    /// Cached SKYE reserve amount
    pub skye_amount: u64,
    /// Cached WSOL reserve amount
    pub wsol_amount: u64,
    /// Swap fee in basis points (e.g. 100 = 1%)
    pub fee_bps: u16,
    /// PDA bump
    pub bump: u8,
    /// LP mint authority PDA bump
    pub lp_authority_bump: u8,
    /// Team wallet — receives 50% of swap fees
    pub team_wallet: Pubkey,
    /// Diamond vault — 17.5% of fees, for holders who never sold before 5x
    pub diamond_vault: Pubkey,
    /// Strong vault — 7.5% of fees, for holders who sold before 5x but kept 50%+ bag
    pub strong_vault: Pubkey,
}
