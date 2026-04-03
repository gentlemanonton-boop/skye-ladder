use anchor_lang::prelude::*;

#[error_code]
pub enum SkyeAmmError {
    #[msg("Insufficient liquidity in the pool")]
    InsufficientLiquidity,
    #[msg("Output amount is below minimum (slippage exceeded)")]
    SlippageExceeded,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Invalid mint address")]
    InvalidMint,
    #[msg("Insufficient LP tokens")]
    InsufficientLpTokens,
    #[msg("Fee basis points must be <= 10000")]
    InvalidFee,
}
