use anchor_lang::prelude::*;

#[error_code]
pub enum SkyeLadderError {
    #[msg("Sell amount exceeds unlocked tokens across all positions")]
    SellExceedsUnlocked,

    #[msg("Maximum positions per wallet (10) exceeded")]
    MaxPositionsExceeded,

    #[msg("Arithmetic overflow in fixed-point calculation")]
    MathOverflow,

    #[msg("Invalid pool address")]
    InvalidPool,

    #[msg("Per-block buy limit exceeded for current market cap range")]
    BuyLimitExceeded,

    #[msg("Price must be greater than zero")]
    ZeroPrice,

    #[msg("Token balance must be greater than zero")]
    ZeroTokens,

    #[msg("Unauthorized: only admin can perform this action")]
    Unauthorized,

    #[msg("Program is paused")]
    Paused,
}
