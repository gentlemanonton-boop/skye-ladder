import { useCallback, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  PublicKey, SystemProgram, LAMPORTS_PER_SOL, ComputeBudgetProgram,
  TransactionInstruction, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, NATIVE_MINT,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction, createCloseAccountInstruction, ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Program, AnchorProvider } from "@coral-xyz/anchor";
import ladderIdl from "../idl/skye_ladder.json";
import { SKYE_MINT, SKYE_LADDER_PROGRAM_ID, SKYE_CURVE_ID, SKYE_AMM_PROGRAM_ID, SWAP_DISC, TREASURY_WALLET } from "../constants";
import { getCurvePDA, getWalletRecordPDA, getConfigPDA, getExtraMetasPDA } from "../lib/pda";

export function useSwap() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const [pending, setPending] = useState(false);
  const [lastTx, setLastTx] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const swap = useCallback(
    async (
      amountRaw: bigint,
      buy: boolean,
      minOut: bigint = 0n,
      graduated?: boolean,
      poolState?: { poolPDA: string; skyeReserveKey: string; wsolReserveKey: string; teamWallet: string },
    ) => {
      if (!publicKey || !sendTransaction) return;
      setPending(true); setError(null); setLastTx(null);

      try {
        const userToken = getAssociatedTokenAddressSync(SKYE_MINT, publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
        const userWsol = getAssociatedTokenAddressSync(NATIVE_MINT, publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

        const [tokenInfo, wsolInfo, buyerWRInfo] = await Promise.all([
          connection.getAccountInfo(userToken),
          connection.getAccountInfo(userWsol),
          connection.getAccountInfo(getWalletRecordPDA(publicKey)[0]),
        ]);

        const ixs: TransactionInstruction[] = [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
        ];

        if (!tokenInfo) ixs.push(createAssociatedTokenAccountInstruction(publicKey, userToken, publicKey, SKYE_MINT, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
        if (!wsolInfo) ixs.push(createAssociatedTokenAccountInstruction(publicKey, userWsol, publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));

        const [buyerWR] = getWalletRecordPDA(publicKey);
        if (!buyerWRInfo) {
          const provider = new AnchorProvider(connection, { publicKey, signTransaction: null, signAllTransactions: null } as any, { commitment: "confirmed" });
          const ladderProgram = new Program(ladderIdl as any, provider);
          ixs.push(await (ladderProgram.methods as any).createWalletRecord()
            .accounts({ payer: publicKey, wallet: publicKey, mint: SKYE_MINT, walletRecord: buyerWR, systemProgram: SystemProgram.programId }).instruction());
        }

        if (buy) {
          ixs.push(
            SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: userWsol, lamports: Number(amountRaw) }),
            createSyncNativeInstruction(userWsol, TOKEN_PROGRAM_ID),
          );
        }

        const [configPDA] = getConfigPDA();
        const [extraMetasPDA] = getExtraMetasPDA();

        const swapData = Buffer.alloc(8 + 8 + 8 + 1);
        swapData.set(SWAP_DISC, 0);
        swapData.writeBigUInt64LE(amountRaw, 8);
        swapData.writeBigUInt64LE(minOut, 16);
        swapData[24] = buy ? 1 : 0;

        if (graduated && poolState) {
          const ammPoolPDA = new PublicKey(poolState.poolPDA);
          const skyeReserve = new PublicKey(poolState.skyeReserveKey);
          const wsolReserve = new PublicKey(poolState.wsolReserveKey);
          const teamWallet = new PublicKey(poolState.teamWallet);

          const [poolWR] = getWalletRecordPDA(ammPoolPDA);
          const senderWR = buy ? poolWR : buyerWR;
          const receiverWR = buy ? buyerWR : poolWR;

          const hookAccounts = [
            { pubkey: configPDA, isSigner: false, isWritable: false },
            { pubkey: senderWR, isSigner: false, isWritable: true },
            { pubkey: receiverWR, isSigner: false, isWritable: true },
            { pubkey: ammPoolPDA, isSigner: false, isWritable: false },
            { pubkey: SKYE_LADDER_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: extraMetasPDA, isSigner: false, isWritable: false },
          ];

          const teamWalletAccount = { pubkey: teamWallet, isSigner: false, isWritable: true };

          ixs.push(new TransactionInstruction({
            keys: [
              { pubkey: publicKey, isSigner: true, isWritable: true },
              { pubkey: ammPoolPDA, isSigner: false, isWritable: true },
              { pubkey: SKYE_MINT, isSigner: false, isWritable: false },
              { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
              { pubkey: userToken, isSigner: false, isWritable: true },
              { pubkey: userWsol, isSigner: false, isWritable: true },
              { pubkey: skyeReserve, isSigner: false, isWritable: true },
              { pubkey: wsolReserve, isSigner: false, isWritable: true },
              { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
              ...hookAccounts,
              teamWalletAccount,
            ],
            programId: SKYE_AMM_PROGRAM_ID,
            data: swapData,
          }));
        } else {
          const [curvePDA] = getCurvePDA();
          const tokenReserve = getAssociatedTokenAddressSync(SKYE_MINT, curvePDA, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
          const solReserve = getAssociatedTokenAddressSync(NATIVE_MINT, curvePDA, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
          const treasuryWsol = getAssociatedTokenAddressSync(NATIVE_MINT, TREASURY_WALLET, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

          const [curveWR] = PublicKey.findProgramAddressSync([Buffer.from("wallet"), curvePDA.toBuffer(), SKYE_MINT.toBuffer()], SKYE_LADDER_PROGRAM_ID);
          const senderWR = buy ? curveWR : buyerWR;
          const receiverWR = buy ? buyerWR : curveWR;

          const hookAccounts = [
            { pubkey: configPDA, isSigner: false, isWritable: false },
            { pubkey: senderWR, isSigner: false, isWritable: true },
            { pubkey: receiverWR, isSigner: false, isWritable: true },
            { pubkey: curvePDA, isSigner: false, isWritable: false },
            { pubkey: SKYE_LADDER_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: extraMetasPDA, isSigner: false, isWritable: false },
          ];

          ixs.push(new TransactionInstruction({
            keys: [
              { pubkey: publicKey, isSigner: true, isWritable: true },
              { pubkey: curvePDA, isSigner: false, isWritable: true },
              { pubkey: SKYE_MINT, isSigner: false, isWritable: false },
              { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
              { pubkey: userToken, isSigner: false, isWritable: true },
              { pubkey: userWsol, isSigner: false, isWritable: true },
              { pubkey: tokenReserve, isSigner: false, isWritable: true },
              { pubkey: solReserve, isSigner: false, isWritable: true },
              { pubkey: treasuryWsol, isSigner: false, isWritable: true },
              { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
              ...hookAccounts,
            ],
            programId: SKYE_CURVE_ID,
            data: swapData,
          }));
        }

        if (!buy) {
          ixs.push(createCloseAccountInstruction(userWsol, publicKey, publicKey, [], TOKEN_PROGRAM_ID));
        }

        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
        const messageV0 = new TransactionMessage({
          payerKey: publicKey,
          recentBlockhash: blockhash,
          instructions: ixs,
        }).compileToV0Message();
        const vtx = new VersionedTransaction(messageV0);

        const sig = await sendTransaction(vtx, connection);
        await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
        setLastTx(sig);
      } catch (e: any) {
        let msg = "Transaction failed";
        if (e?.message?.includes("SellExceedsUnlocked")) msg = "Sell amount exceeds unlocked tokens.";
        else if (e?.message?.includes("User rejected")) msg = "Transaction cancelled.";
        else if (e?.message?.includes("insufficient funds")) msg = "Insufficient SOL.";
        else if (e?.message) msg = e.message;
        console.error("Swap error:", e);
        setError(msg);
      }
      setPending(false);
    },
    [connection, publicKey, sendTransaction]
  );

  return { swap, pending, lastTx, error };
}
