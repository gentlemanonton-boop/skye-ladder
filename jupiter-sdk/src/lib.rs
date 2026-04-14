//! Jupiter AMM interface adapter for Skye AMM.
//!
//! Implements the `jupiter_amm_interface::Amm` trait so Jupiter's Metis
//! routing engine can discover, quote, and route swaps through Skye AMM
//! pools. Handles the Token-2022 Transfer Hook extra accounts that the
//! Skye Ladder hook requires on every SKYE transfer.

mod pool;
mod quote;
mod hook;

pub use pool::SkyeAmm;
