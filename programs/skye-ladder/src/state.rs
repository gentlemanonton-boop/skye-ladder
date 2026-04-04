use anchor_lang::prelude::*;

/// Maximum number of independent positions per wallet.
pub const MAX_POSITIONS: usize = 10;

/// Fixed-point scale for prices: 10^18
pub const PRICE_SCALE: u128 = 1_000_000_000_000_000_000;

/// Basis points denominator (100% = 10_000 bps)
pub const BPS_DENOMINATOR: u32 = 10_000;

/// Merge threshold: 10% proximity (1_000 bps)
pub const MERGE_THRESHOLD_BPS: u64 = 1_000;

/// 5x multiplier threshold in mult-scaled units (mult * 10_000)
pub const MULT_5X: u128 = 50_000;

/// Global configuration for the Skye Ladder program.
#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Admin authority (can update pool, pause, etc.)
    pub authority: Pubkey,
    /// The token mint this hook is attached to
    pub mint: Pubkey,
    /// Whitelisted AMM pool SKYE token account (for buy/sell classification)
    pub pool: Pubkey,
    /// AMM Pool account address (for reading spot price)
    pub lb_pair: Pubkey,
    /// Whether the program is paused
    pub paused: bool,
    /// Bump seed for the config PDA
    pub bump: u8,
}

/// Per-wallet record storing all independent buy positions.
/// PDA seeds: [b"wallet", wallet_pubkey, mint_pubkey]
#[account]
#[derive(InitSpace)]
pub struct WalletRecord {
    /// The wallet this record belongs to
    pub owner: Pubkey,
    /// The token mint
    pub mint: Pubkey,
    /// Number of active positions
    pub position_count: u8,
    /// Independent buy positions (fixed array, use position_count for active)
    #[max_len(10)]
    pub positions: Vec<Position>,
    /// Slot of the last buy (for per-block buy limits — legacy, unused)
    pub last_buy_slot: u64,
    /// Legacy field (unused)
    pub slot_buy_usd: u64,
    /// Bump seed for this PDA
    pub bump: u8,
}

/// A single buy position with its own entry price and unlock tracking.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, InitSpace)]
pub struct Position {
    /// Entry price at time of buy, scaled by 10^18
    pub entry_price: u64,
    /// Initial SOL value of the buy (tokens * price / PRICE_SCALE)
    pub initial_sol: u64,
    /// Current token balance in this position (raw lamports)
    pub token_balance: u64,
    /// High-water mark of unlocked basis points (0-10_000)
    pub unlocked_bps: u32,
    /// Original token balance at time of buy (before any sells).
    pub original_balance: u64,
    /// True if any sell was executed while multiplier < 5x.
    /// Once set, never clears. Merged positions inherit dirty flag.
    pub sold_before_5x: bool,
    /// True after claim_rewards has been called on this position.
    pub claimed: bool,
}

impl Position {
    pub fn is_empty(&self) -> bool {
        self.token_balance == 0
    }
}
