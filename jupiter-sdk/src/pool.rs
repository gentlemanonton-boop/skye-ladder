//! Jupiter `Amm` trait implementation for Skye AMM pools.

use anyhow::{anyhow, Result};
use jupiter_amm_interface::{
    Amm, AccountMap, AmmContext, KeyedAccount, Quote, QuoteParams,
    SwapAndAccountMetas, SwapParams,
};
use rust_decimal::Decimal;
use solana_pubkey::{Pubkey, pubkey};
use solana_instruction::AccountMeta;

use crate::hook;
use crate::quote as q;

/// Skye AMM program ID (mainnet).
pub const SKYE_AMM_PROGRAM_ID: Pubkey =
    pubkey!("GRBvJRRJfV3CzRLocGcr3NTptWQpu1G4nW9Jpff5TFoX");

const TOKEN_2022_PROGRAM_ID: Pubkey =
    pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

const TOKEN_PROGRAM_ID: Pubkey =
    pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

const WSOL_MINT: Pubkey =
    pubkey!("So11111111111111111111111111111111111111112");

// ── Pool account layout offsets (see docs/market-layout.md) ─────────────
const POOL_SKYE_MINT_OFFSET: usize = 40;
const POOL_WSOL_MINT_OFFSET: usize = 72;
const POOL_SKYE_RESERVE_OFFSET: usize = 104;
const POOL_WSOL_RESERVE_OFFSET: usize = 136;
const POOL_SKYE_AMOUNT_OFFSET: usize = 200;
const POOL_WSOL_AMOUNT_OFFSET: usize = 208;
const POOL_FEE_BPS_OFFSET: usize = 216;
const POOL_BUMP_OFFSET: usize = 218;
const POOL_TEAM_WALLET_OFFSET: usize = 220;
const POOL_MIN_SIZE: usize = 252;

fn swap_discriminator() -> [u8; 8] {
    use sha2::{Sha256, Digest};
    let hash = Sha256::digest(b"global:swap");
    let mut disc = [0u8; 8];
    disc.copy_from_slice(&hash[..8]);
    disc
}

fn read_pubkey(data: &[u8], offset: usize) -> Pubkey {
    Pubkey::new_from_array(data[offset..offset + 32].try_into().unwrap())
}

fn read_u64(data: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(data[offset..offset + 8].try_into().unwrap())
}

fn read_u16(data: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(data[offset..offset + 2].try_into().unwrap())
}

/// Jupiter adapter for a single Skye AMM pool.
pub struct SkyeAmm {
    key: Pubkey,
    skye_mint: Pubkey,
    wsol_mint: Pubkey,
    skye_reserve: Pubkey,
    wsol_reserve: Pubkey,
    skye_amount: u64,
    wsol_amount: u64,
    fee_bps: u16,
    team_wallet: Pubkey,
    lb_pair: Pubkey,
}

impl Clone for SkyeAmm {
    fn clone(&self) -> Self {
        SkyeAmm {
            key: self.key,
            skye_mint: self.skye_mint,
            wsol_mint: self.wsol_mint,
            skye_reserve: self.skye_reserve,
            wsol_reserve: self.wsol_reserve,
            skye_amount: self.skye_amount,
            wsol_amount: self.wsol_amount,
            fee_bps: self.fee_bps,
            team_wallet: self.team_wallet,
            lb_pair: self.lb_pair,
        }
    }
}

impl Amm for SkyeAmm {
    fn from_keyed_account(keyed_account: &KeyedAccount, _amm_context: &AmmContext) -> Result<Self> {
        let data = &keyed_account.account.data;
        if data.len() < POOL_MIN_SIZE {
            return Err(anyhow!("Pool account too small: {} bytes", data.len()));
        }

        let skye_mint = read_pubkey(data, POOL_SKYE_MINT_OFFSET);

        Ok(SkyeAmm {
            key: keyed_account.key,
            skye_mint,
            wsol_mint: read_pubkey(data, POOL_WSOL_MINT_OFFSET),
            skye_reserve: read_pubkey(data, POOL_SKYE_RESERVE_OFFSET),
            wsol_reserve: read_pubkey(data, POOL_WSOL_RESERVE_OFFSET),
            skye_amount: read_u64(data, POOL_SKYE_AMOUNT_OFFSET),
            wsol_amount: read_u64(data, POOL_WSOL_AMOUNT_OFFSET),
            fee_bps: read_u16(data, POOL_FEE_BPS_OFFSET),
            team_wallet: read_pubkey(data, POOL_TEAM_WALLET_OFFSET),
            lb_pair: hook::hook_config_pda(&skye_mint), // placeholder until update()
        })
    }

    fn label(&self) -> String {
        "Skye AMM".to_string()
    }

    fn program_id(&self) -> Pubkey {
        SKYE_AMM_PROGRAM_ID
    }

    fn key(&self) -> Pubkey {
        self.key
    }

    fn get_reserve_mints(&self) -> Vec<Pubkey> {
        vec![self.skye_mint, self.wsol_mint]
    }

    fn get_accounts_to_update(&self) -> Vec<Pubkey> {
        vec![self.key, hook::hook_config_pda(&self.skye_mint)]
    }

    fn update(&mut self, account_map: &AccountMap) -> Result<()> {
        if let Some(pool_data) = account_map.get(&self.key) {
            let data = &pool_data.data;
            if data.len() >= POOL_MIN_SIZE {
                self.skye_amount = read_u64(data, POOL_SKYE_AMOUNT_OFFSET);
                self.wsol_amount = read_u64(data, POOL_WSOL_AMOUNT_OFFSET);
                self.fee_bps = read_u16(data, POOL_FEE_BPS_OFFSET);
                self.team_wallet = read_pubkey(data, POOL_TEAM_WALLET_OFFSET);
            }
        }

        let config_key = hook::hook_config_pda(&self.skye_mint);
        if let Some(config_data) = account_map.get(&config_key) {
            if let Some(lb_pair) = hook::read_lb_pair_from_config(&config_data.data) {
                self.lb_pair = lb_pair;
            }
        }

        Ok(())
    }

    fn quote(&self, quote_params: &QuoteParams) -> Result<Quote> {
        let (reserve_in, reserve_out) = if quote_params.input_mint == self.wsol_mint {
            (self.wsol_amount, self.skye_amount)
        } else if quote_params.input_mint == self.skye_mint {
            (self.skye_amount, self.wsol_amount)
        } else {
            return Err(anyhow!("Unknown input mint: {}", quote_params.input_mint));
        };

        let (out_amount, fee_amount) = q::compute_swap_output(
            reserve_in,
            reserve_out,
            quote_params.amount,
            self.fee_bps,
        )
        .ok_or_else(|| anyhow!("Swap computation failed"))?;

        Ok(Quote {
            out_amount,
            in_amount: quote_params.amount,
            fee_amount,
            fee_mint: quote_params.input_mint,
            fee_pct: Decimal::new(self.fee_bps as i64, 2),
            ..Quote::default()
        })
    }

    fn get_swap_and_account_metas(
        &self,
        swap_params: &SwapParams,
    ) -> Result<SwapAndAccountMetas> {
        let is_buy = swap_params.source_mint == self.wsol_mint;

        // For buy: pool sends SKYE → pool is sender, user is receiver
        // For sell: user sends SKYE → user is sender, pool is receiver
        let (sender_owner, receiver_owner) = if is_buy {
            (self.key, swap_params.token_transfer_authority)
        } else {
            (swap_params.token_transfer_authority, self.key)
        };

        // Swap instruction data: [8 disc][8 amount_in][8 min_out][1 buy]
        let disc = swap_discriminator();
        let mut data = Vec::with_capacity(25);
        data.extend_from_slice(&disc);
        data.extend_from_slice(&swap_params.in_amount.to_le_bytes());
        data.extend_from_slice(&swap_params.out_amount.to_le_bytes());
        data.push(if is_buy { 1u8 } else { 0u8 });

        // Accounts — order must match swap.rs Swap struct.
        // For buy: source=user_wsol, dest=user_skye
        // For sell: source=user_skye, dest=user_wsol
        let (user_skye_account, user_wsol_account) = if is_buy {
            (swap_params.destination_token_account, swap_params.source_token_account)
        } else {
            (swap_params.source_token_account, swap_params.destination_token_account)
        };

        let mut account_metas = vec![
            AccountMeta::new(swap_params.token_transfer_authority, true),
            AccountMeta::new(self.key, false),
            AccountMeta::new_readonly(self.skye_mint, false),
            AccountMeta::new_readonly(WSOL_MINT, false),
            AccountMeta::new(user_skye_account, false),
            AccountMeta::new(user_wsol_account, false),
            AccountMeta::new(self.skye_reserve, false),
            AccountMeta::new(self.wsol_reserve, false),
            AccountMeta::new_readonly(TOKEN_2022_PROGRAM_ID, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
        ];

        // Hook extra accounts (remaining_accounts)
        account_metas.extend(hook::build_hook_account_metas(
            &self.skye_mint,
            &sender_owner,
            &receiver_owner,
            &self.lb_pair,
        ));

        // Team wallet for fee routing
        if self.team_wallet != Pubkey::default() {
            account_metas.push(AccountMeta::new(self.team_wallet, false));
        }

        Ok(SwapAndAccountMetas {
            swap: jupiter_amm_interface::Swap::TokenSwap,
            account_metas,
        })
    }

    fn clone_amm(&self) -> Box<dyn Amm + Send + Sync> {
        Box::new(self.clone())
    }

    fn has_dynamic_accounts(&self) -> bool {
        true // Hook wallet record PDAs change per user
    }

    fn get_accounts_len(&self) -> usize {
        17 // 10 core + 6 hook + 1 team wallet
    }
}
