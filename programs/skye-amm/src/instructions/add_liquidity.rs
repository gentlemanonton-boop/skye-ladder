use anchor_lang::prelude::*;
use anchor_spl::{
    token::Token,
    token_2022::Token2022,
    token_interface::{
        self, Mint as InterfaceMint, TokenAccount as InterfaceTokenAccount,
        TransferChecked, MintTo,
    },
};
use solana_program::program::invoke;

use crate::errors::SkyeAmmError;
use crate::math;
use crate::state::Pool;

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, AddLiquidity<'info>>,
    skye_amount: u64,
    wsol_amount: u64,
    min_lp_tokens: u64,
) -> Result<()> {
    require!(skye_amount > 0 && wsol_amount > 0, SkyeAmmError::ZeroAmount);

    let pool = &ctx.accounts.pool;
    let lp_supply = ctx.accounts.lp_mint.supply;

    let lp_tokens = if lp_supply == 0 {
        math::compute_initial_lp(skye_amount, wsol_amount)?
    } else {
        math::compute_proportional_lp(
            skye_amount,
            wsol_amount,
            pool.skye_amount,
            pool.wsol_amount,
            lp_supply,
        )?
    };

    require!(lp_tokens >= min_lp_tokens, SkyeAmmError::SlippageExceeded);
    require!(lp_tokens > 0, SkyeAmmError::ZeroAmount);

    // Transfer SKYE from user to pool reserve (Token-2022 — triggers transfer hook)
    // Use raw invoke to properly forward all hook accounts
    transfer_token2022_with_hook(
        &ctx.accounts.user_skye_account.to_account_info(),
        &ctx.accounts.skye_mint.to_account_info(),
        &ctx.accounts.skye_reserve.to_account_info(),
        &ctx.accounts.user.to_account_info(),
        &ctx.accounts.token_2022_program.to_account_info(),
        ctx.remaining_accounts,
        skye_amount,
        ctx.accounts.skye_mint.decimals,
        &[], // user signs directly, no PDA seeds
    )?;

    // Transfer WSOL from user to pool reserve (standard Token program)
    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.user_wsol_account.to_account_info(),
                mint: ctx.accounts.wsol_mint.to_account_info(),
                to: ctx.accounts.wsol_reserve.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        wsol_amount,
        ctx.accounts.wsol_mint.decimals,
    )?;

    // Mint LP tokens to user
    let pool_key = ctx.accounts.pool.key();
    let lp_auth_seeds: &[&[u8]] = &[
        b"lp-authority",
        pool_key.as_ref(),
        &[ctx.accounts.pool.lp_authority_bump],
    ];

    token_interface::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.lp_mint.to_account_info(),
                to: ctx.accounts.user_lp_account.to_account_info(),
                authority: ctx.accounts.lp_authority.to_account_info(),
            },
            &[lp_auth_seeds],
        ),
        lp_tokens,
    )?;

    // Update cached reserves
    let pool = &mut ctx.accounts.pool;
    pool.skye_amount = pool.skye_amount.checked_add(skye_amount)
        .ok_or(SkyeAmmError::MathOverflow)?;
    pool.wsol_amount = pool.wsol_amount.checked_add(wsol_amount)
        .ok_or(SkyeAmmError::MathOverflow)?;

    msg!(
        "Added liquidity: {} SKYE + {} WSOL -> {} LP",
        skye_amount, wsol_amount, lp_tokens,
    );

    Ok(())
}

/// Transfer Token-2022 tokens with proper hook account forwarding.
/// Uses raw `invoke` / `invoke_signed` to ensure all extra accounts
/// (ExtraAccountMetaList, hook program, wallet records, etc.) are
/// properly available for the Token-2022 → TransferHook nested CPI.
pub fn transfer_token2022_with_hook<'info>(
    from: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    extra_accounts: &[AccountInfo<'info>],
    amount: u64,
    decimals: u8,
    signer_seeds: &[&[u8]],
) -> Result<()> {
    let mut ix = spl_token_2022::instruction::transfer_checked(
        token_program.key,
        from.key,
        mint.key,
        to.key,
        authority.key,
        &[],
        amount,
        decimals,
    )?;

    // Append hook extra accounts to the instruction
    for account in extra_accounts {
        ix.accounts.push(solana_program::instruction::AccountMeta {
            pubkey: *account.key,
            is_signer: account.is_signer,
            is_writable: account.is_writable,
        });
    }

    // Build full account_infos: token_program + standard 4 + extras
    let mut account_infos = vec![
        from.clone(),
        mint.clone(),
        to.clone(),
        authority.clone(),
    ];
    for account in extra_accounts {
        account_infos.push(account.clone());
    }

    if signer_seeds.is_empty() {
        invoke(&ix, &account_infos)?;
    } else {
        solana_program::program::invoke_signed(&ix, &account_infos, &[signer_seeds])?;
    }

    Ok(())
}

#[derive(Accounts)]
pub struct AddLiquidity<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool", pool.skye_mint.as_ref(), pool.wsol_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, Pool>>,

    pub skye_mint: Box<InterfaceAccount<'info, InterfaceMint>>,
    pub wsol_mint: Box<InterfaceAccount<'info, InterfaceMint>>,

    #[account(mut, token::mint = skye_mint, token::authority = user)]
    pub user_skye_account: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,

    #[account(mut, token::mint = wsol_mint, token::authority = user)]
    pub user_wsol_account: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,

    #[account(mut, constraint = skye_reserve.key() == pool.skye_reserve)]
    pub skye_reserve: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,

    #[account(mut, constraint = wsol_reserve.key() == pool.wsol_reserve)]
    pub wsol_reserve: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,

    #[account(mut, constraint = lp_mint.key() == pool.lp_mint)]
    pub lp_mint: Box<InterfaceAccount<'info, InterfaceMint>>,

    #[account(mut, token::mint = lp_mint)]
    pub user_lp_account: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,

    /// CHECK: PDA used only as signing authority for LP mint.
    #[account(
        seeds = [b"lp-authority", pool.key().as_ref()],
        bump = pool.lp_authority_bump,
    )]
    pub lp_authority: AccountInfo<'info>,

    pub token_2022_program: Program<'info, Token2022>,
    pub token_program: Program<'info, Token>,
}
