//! Transfer Hook extra account resolution for the Skye Ladder hook.

use solana_pubkey::Pubkey;
use solana_instruction::AccountMeta;

/// Skye Ladder transfer hook program ID (mainnet).
pub const SKYE_LADDER_PROGRAM_ID: Pubkey =
    solana_pubkey::pubkey!("4THAwb6WSpDyyqMHnJL2VBjU7TCLfLLGC5jtuCiyX5Rz");

/// Derive the ExtraAccountMetaList PDA for a given mint.
pub fn extra_metas_pda(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[b"extra-account-metas", mint.as_ref()],
        &SKYE_LADDER_PROGRAM_ID,
    )
    .0
}

/// Derive the hook Config PDA for a given mint.
pub fn hook_config_pda(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[b"config", mint.as_ref()],
        &SKYE_LADDER_PROGRAM_ID,
    )
    .0
}

/// Derive a WalletRecord PDA for a given owner + mint.
pub fn wallet_record_pda(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[b"wallet", owner.as_ref(), mint.as_ref()],
        &SKYE_LADDER_PROGRAM_ID,
    )
    .0
}

/// Config layout offset for lb_pair: 8 disc + 32 authority + 32 mint + 32 pool = 104
const CONFIG_LB_PAIR_OFFSET: usize = 104;

/// Read the lb_pair pubkey from a hook Config account's raw data.
pub fn read_lb_pair_from_config(data: &[u8]) -> Option<Pubkey> {
    if data.len() < CONFIG_LB_PAIR_OFFSET + 32 {
        return None;
    }
    let bytes: [u8; 32] = data[CONFIG_LB_PAIR_OFFSET..CONFIG_LB_PAIR_OFFSET + 32]
        .try_into()
        .ok()?;
    Some(Pubkey::new_from_array(bytes))
}

/// Build the Transfer Hook extra account metas for a swap.
///
/// Order matches the on-chain hook's ExtraAccountMetaList:
///   1. ExtraAccountMetaList PDA (read-only)
///   2. Hook Config PDA (read-only)
///   3. Sender WalletRecord PDA (writable)
///   4. Receiver WalletRecord PDA (writable)
///   5. LbPair / Pool PDA (read-only)
///   6. Skye Ladder program (read-only)
pub fn build_hook_account_metas(
    mint: &Pubkey,
    sender: &Pubkey,
    receiver: &Pubkey,
    lb_pair: &Pubkey,
) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new_readonly(extra_metas_pda(mint), false),
        AccountMeta::new_readonly(hook_config_pda(mint), false),
        AccountMeta::new(wallet_record_pda(sender, mint), false),
        AccountMeta::new(wallet_record_pda(receiver, mint), false),
        AccountMeta::new_readonly(*lb_pair, false),
        AccountMeta::new_readonly(SKYE_LADDER_PROGRAM_ID, false),
    ]
}
