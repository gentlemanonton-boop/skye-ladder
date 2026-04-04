use anchor_lang::prelude::*;
use anchor_spl::{
    token::Token,
    token_2022::Token2022,
    token_interface::{
        self, Mint as InterfaceMint, TokenAccount as InterfaceTokenAccount,
        TransferChecked,
    },
};
use solana_program::program::invoke;

use crate::errors::SkyeCurveError;
use crate::math;
use crate::state::Curve;

/// Byte offsets for virtual reserves in Curve account data.
/// Used to flush before CPI so the transfer hook reads correct price.
const VIRTUAL_TOKEN_OFFSET: usize = 8 + 32 * 5; // disc + 5 pubkeys = 168
const VIRTUAL_SOL_OFFSET: usize = VIRTUAL_TOKEN_OFFSET + 8; // 176

fn flush_curve_reserves(curve: &Account<'_, Curve>) -> Result<()> {
    let info = curve.to_account_info();
    let mut data = info.try_borrow_mut_data()?;
    data[VIRTUAL_TOKEN_OFFSET..VIRTUAL_TOKEN_OFFSET + 8]
        .copy_from_slice(&curve.virtual_token_reserve.to_le_bytes());
    data[VIRTUAL_SOL_OFFSET..VIRTUAL_SOL_OFFSET + 8]
        .copy_from_slice(&curve.virtual_sol_reserve.to_le_bytes());
    Ok(())
}

/// Transfer Token-2022 tokens with hook account forwarding.
fn transfer_token2022<'info>(
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
        token_program.key, from.key, mint.key, to.key, authority.key,
        &[], amount, decimals,
    )?;
    for account in extra_accounts {
        ix.accounts.push(solana_program::instruction::AccountMeta {
            pubkey: *account.key, is_signer: account.is_signer, is_writable: account.is_writable,
        });
    }
    let mut account_infos = vec![from.clone(), mint.clone(), to.clone(), authority.clone()];
    for account in extra_accounts { account_infos.push(account.clone()); }

    if signer_seeds.is_empty() {
        invoke(&ix, &account_infos)?;
    } else {
        solana_program::program::invoke_signed(&ix, &account_infos, &[signer_seeds])?;
    }
    Ok(())
}

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, SwapCurve<'info>>,
    sol_amount: u64,
    min_out: u64,
    buy: bool,
) -> Result<()> {
    require!(sol_amount > 0, SkyeCurveError::ZeroAmount);

    let curve = &ctx.accounts.curve;
    require!(!curve.graduated, SkyeCurveError::AlreadyGraduated);

    let mint_key = curve.mint;
    let curve_bump = curve.bump;
    let curve_seeds: &[&[u8]] = &[b"curve", mint_key.as_ref(), &[curve_bump]];

    if buy {
        // BUY: SOL in → tokens out
        let (tokens_out, _fee) = math::compute_buy(
            curve.virtual_sol_reserve,
            curve.virtual_token_reserve,
            sol_amount,
            curve.fee_bps,
        )?;
        require!(tokens_out >= min_out, SkyeCurveError::SlippageExceeded);
        require!(tokens_out <= curve.real_token_reserve, SkyeCurveError::InsufficientLiquidity);

        // Update curve state
        let curve = &mut ctx.accounts.curve;
        curve.virtual_sol_reserve = curve.virtual_sol_reserve.checked_add(sol_amount)
            .ok_or(SkyeCurveError::MathOverflow)?;
        curve.virtual_token_reserve = curve.virtual_token_reserve.checked_sub(tokens_out)
            .ok_or(SkyeCurveError::MathOverflow)?;
        curve.real_sol_reserve = curve.real_sol_reserve.checked_add(sol_amount)
            .ok_or(SkyeCurveError::MathOverflow)?;
        curve.real_token_reserve = curve.real_token_reserve.checked_sub(tokens_out)
            .ok_or(SkyeCurveError::MathOverflow)?;

        flush_curve_reserves(curve)?;

        // Transfer WSOL in from user
        token_interface::transfer_checked(
            CpiContext::new(ctx.accounts.token_program.to_account_info(), TransferChecked {
                from: ctx.accounts.user_wsol.to_account_info(),
                mint: ctx.accounts.wsol_mint.to_account_info(),
                to: ctx.accounts.sol_reserve.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            }),
            sol_amount,
            ctx.accounts.wsol_mint.decimals,
        )?;

        // Transfer tokens out from curve reserve (triggers hook as "buy")
        transfer_token2022(
            &ctx.accounts.token_reserve.to_account_info(),
            &ctx.accounts.mint.to_account_info(),
            &ctx.accounts.user_token.to_account_info(),
            &ctx.accounts.curve.to_account_info(),
            &ctx.accounts.token_2022_program.to_account_info(),
            ctx.remaining_accounts,
            tokens_out,
            ctx.accounts.mint.decimals,
            curve_seeds,
        )?;

        // Check graduation
        if ctx.accounts.curve.real_sol_reserve >= ctx.accounts.curve.graduation_sol {
            ctx.accounts.curve.graduated = true;
            msg!("GRADUATED at {} SOL!", ctx.accounts.curve.real_sol_reserve);
        }

        msg!("CURVE BUY: {} SOL -> {} tokens", sol_amount, tokens_out);
    } else {
        // SELL: tokens in → SOL out
        // sol_amount parameter is actually tokens_in for sells
        let tokens_in = sol_amount;
        let (sol_out, _fee) = math::compute_sell(
            curve.virtual_sol_reserve,
            curve.virtual_token_reserve,
            tokens_in,
            curve.fee_bps,
        )?;
        require!(sol_out >= min_out, SkyeCurveError::SlippageExceeded);
        require!(sol_out <= curve.real_sol_reserve, SkyeCurveError::InsufficientLiquidity);

        // Update curve state
        let curve = &mut ctx.accounts.curve;
        curve.virtual_sol_reserve = curve.virtual_sol_reserve.checked_sub(sol_out)
            .ok_or(SkyeCurveError::MathOverflow)?;
        curve.virtual_token_reserve = curve.virtual_token_reserve.checked_add(tokens_in)
            .ok_or(SkyeCurveError::MathOverflow)?;
        curve.real_sol_reserve = curve.real_sol_reserve.checked_sub(sol_out)
            .ok_or(SkyeCurveError::MathOverflow)?;
        curve.real_token_reserve = curve.real_token_reserve.checked_add(tokens_in)
            .ok_or(SkyeCurveError::MathOverflow)?;

        flush_curve_reserves(curve)?;

        // Transfer tokens in from user (triggers hook as "sell" — restrictions enforced)
        transfer_token2022(
            &ctx.accounts.user_token.to_account_info(),
            &ctx.accounts.mint.to_account_info(),
            &ctx.accounts.token_reserve.to_account_info(),
            &ctx.accounts.user.to_account_info(),
            &ctx.accounts.token_2022_program.to_account_info(),
            ctx.remaining_accounts,
            tokens_in,
            ctx.accounts.mint.decimals,
            &[],
        )?;

        // Transfer SOL out to user
        token_interface::transfer_checked(
            CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), TransferChecked {
                from: ctx.accounts.sol_reserve.to_account_info(),
                mint: ctx.accounts.wsol_mint.to_account_info(),
                to: ctx.accounts.user_wsol.to_account_info(),
                authority: ctx.accounts.curve.to_account_info(),
            }, &[curve_seeds]),
            sol_out,
            ctx.accounts.wsol_mint.decimals,
        )?;

        msg!("CURVE SELL: {} tokens -> {} SOL", tokens_in, sol_out);
    }

    Ok(())
}

#[derive(Accounts)]
pub struct SwapCurve<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"curve", curve.mint.as_ref()],
        bump = curve.bump,
    )]
    pub curve: Box<Account<'info, Curve>>,

    pub mint: Box<InterfaceAccount<'info, InterfaceMint>>,
    pub wsol_mint: Box<InterfaceAccount<'info, InterfaceMint>>,

    #[account(mut, token::mint = mint)]
    pub user_token: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,

    #[account(mut, token::mint = wsol_mint)]
    pub user_wsol: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,

    #[account(mut, constraint = token_reserve.key() == curve.token_reserve)]
    pub token_reserve: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,

    #[account(mut, constraint = sol_reserve.key() == curve.sol_reserve)]
    pub sol_reserve: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,

    pub token_2022_program: Program<'info, Token2022>,
    pub token_program: Program<'info, Token>,
}
