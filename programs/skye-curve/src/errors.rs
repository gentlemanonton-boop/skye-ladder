use anchor_lang::prelude::*;

#[error_code]
pub enum SkyeCurveError {
    #[msg("Insufficient liquidity on the curve")]
    InsufficientLiquidity,
    #[msg("Slippage exceeded")]
    SlippageExceeded,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Curve has graduated — trade on DEX")]
    AlreadyGraduated,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Invalid configuration")]
    InvalidConfig,
}
