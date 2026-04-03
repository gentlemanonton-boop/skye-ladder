use anchor_lang::prelude::*;

/// Constant-product AMM pool for SKYE (Token-2022) / WSOL.
///
/// The pool caches reserve amounts directly so the Skye Ladder transfer hook
/// can read the spot price from this account without loading token accounts.
#[account]
#[derive(InitSpace)]
pub struct Pool {
    /// Admin authority
    pub authority: Pubkey,
    /// SKYE mint (Token-2022 with TransferHook)
    pub skye_mint: Pubkey,
    /// WSOL mint (native SOL mint)
    pub wsol_mint: Pubkey,
    /// Token-2022 account holding SKYE reserves (whitelisted in Skye Ladder config.pool)
    pub skye_reserve: Pubkey,
    /// SPL Token account holding WSOL reserves
    pub wsol_reserve: Pubkey,
    /// LP token mint
    pub lp_mint: Pubkey,
    /// Cached SKYE reserve amount (updated on every swap/add/remove)
    pub skye_amount: u64,
    /// Cached WSOL reserve amount (updated on every swap/add/remove)
    pub wsol_amount: u64,
    /// Swap fee in basis points (e.g. 100 = 1%)
    pub fee_bps: u16,
    /// PDA bump
    pub bump: u8,
    /// LP mint authority PDA bump
    pub lp_authority_bump: u8,
}
