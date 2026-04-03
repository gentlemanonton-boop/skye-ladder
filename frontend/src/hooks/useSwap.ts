import { useCallback, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import ammIdl from "../idl/skye_amm.json";
import ladderIdl from "../idl/skye_ladder.json";
import { SKYE_MINT, SKYE_LADDER_PROGRAM_ID } from "../constants";
import { getPoolPDA, getWalletRecordPDA } from "../lib/pda";
import { deriveHookAccounts } from "../lib/hookAccounts";

export function useSwap() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const [pending, setPending] = useState(false);
  const [lastTx, setLastTx] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const swap = useCallback(
    async (amountRaw: bigint, buy: boolean, minOut: bigint = 0n) => {
      if (!publicKey || !sendTransaction) return;
      setPending(true);
      setError(null);
      setLastTx(null);

      try {
        const provider = new AnchorProvider(
          connection,
          { publicKey, signTransaction: null, signAllTransactions: null } as any,
          { commitment: "confirmed" }
        );
        const ammProgram = new Program(ammIdl as any, provider);
        const ladderProgram = new Program(ladderIdl as any, provider);

        const [poolPDA] = getPoolPDA();
        const skyeReserve = getAssociatedTokenAddressSync(
          SKYE_MINT, poolPDA, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
        );
        const wsolReserve = getAssociatedTokenAddressSync(
          NATIVE_MINT, poolPDA, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
        );
        const userSkyeATA = getAssociatedTokenAddressSync(
          SKYE_MINT, publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
        );
        const userWsolATA = getAssociatedTokenAddressSync(
          NATIVE_MINT, publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
        );

        // ── Setup transaction (if needed) ──
        const setupTx = new Transaction();
        let needsSetup = false;

        // Ensure SKYE ATA exists
        const skyeInfo = await connection.getAccountInfo(userSkyeATA);
        if (!skyeInfo) {
          setupTx.add(createAssociatedTokenAccountInstruction(
            publicKey, userSkyeATA, publicKey, SKYE_MINT,
            TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
          ));
          needsSetup = true;
        }

        // Ensure WSOL ATA exists
        const wsolInfo = await connection.getAccountInfo(userWsolATA);
        if (!wsolInfo) {
          setupTx.add(createAssociatedTokenAccountInstruction(
            publicKey, userWsolATA, publicKey, NATIVE_MINT,
            TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
          ));
          needsSetup = true;
        }

        // Ensure WalletRecords exist
        const [buyerWR] = getWalletRecordPDA(publicKey);
        const wrInfo = await connection.getAccountInfo(buyerWR);
        if (!wrInfo) {
          const ix = await (ladderProgram.methods as any)
            .createWalletRecord()
            .accounts({
              payer: publicKey, wallet: publicKey, mint: SKYE_MINT,
              walletRecord: buyerWR, systemProgram: SystemProgram.programId,
            })
            .instruction();
          setupTx.add(ix);
          needsSetup = true;
        }

        const [poolWR] = getWalletRecordPDA(poolPDA);
        const poolWRInfo = await connection.getAccountInfo(poolWR);
        if (!poolWRInfo) {
          const ix = await (ladderProgram.methods as any)
            .createWalletRecord()
            .accounts({
              payer: publicKey, wallet: poolPDA, mint: SKYE_MINT,
              walletRecord: poolWR, systemProgram: SystemProgram.programId,
            })
            .instruction();
          setupTx.add(ix);
          needsSetup = true;
        }

        // Send setup tx first if needed (separate tx to avoid size limits)
        if (needsSetup) {
          setupTx.feePayer = publicKey;
          setupTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
          const setupSig = await sendTransaction(setupTx, connection);
          await connection.confirmTransaction(setupSig, "confirmed");
        }

        // ── Swap transaction ──
        const swapTx = new Transaction();

        if (buy) {
          // Wrap SOL into WSOL ATA
          swapTx.add(
            SystemProgram.transfer({
              fromPubkey: publicKey,
              toPubkey: userWsolATA,
              lamports: Number(amountRaw),
            }),
            createSyncNativeInstruction(userWsolATA, TOKEN_PROGRAM_ID)
          );
        }

        // Derive hook accounts
        const senderOwner = buy ? poolPDA : publicKey;
        const receiverOwner = buy ? publicKey : poolPDA;
        const hookAccounts = deriveHookAccounts(senderOwner, receiverOwner);

        // Build swap instruction
        const swapIx = await (ammProgram.methods as any)
          .swap(new BN(amountRaw.toString()), new BN(minOut.toString()), buy)
          .accounts({
            user: publicKey,
            pool: poolPDA,
            skyeMint: SKYE_MINT,
            wsolMint: NATIVE_MINT,
            userSkyeAccount: userSkyeATA,
            userWsolAccount: userWsolATA,
            skyeReserve,
            wsolReserve,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .remainingAccounts(hookAccounts)
          .instruction();

        swapTx.add(swapIx);

        // For sells: unwrap WSOL back to native SOL after the swap
        if (!buy) {
          swapTx.add(
            createCloseAccountInstruction(
              userWsolATA, publicKey, publicKey, [], TOKEN_PROGRAM_ID
            )
          );
        }

        swapTx.feePayer = publicKey;
        swapTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

        const sig = await sendTransaction(swapTx, connection);
        await connection.confirmTransaction(sig, "confirmed");
        setLastTx(sig);
      } catch (e: any) {
        // Extract useful error message from various error formats
        let msg = "Transaction failed";
        if (e?.message?.includes("SellExceedsUnlocked")) {
          msg = "Sell amount exceeds your unlocked tokens. Check your available balance.";
        } else if (e?.message?.includes("BuyLimitExceeded")) {
          msg = "Buy exceeds per-block limit at this market cap. Try a smaller amount.";
        } else if (e?.message?.includes("User rejected")) {
          msg = "Transaction cancelled.";
        } else if (e?.message?.includes("insufficient funds")) {
          msg = "Insufficient SOL balance for this transaction.";
        } else if (e?.message?.includes("0x1")) {
          msg = "Insufficient token balance.";
        } else if (e?.logs) {
          // Try to find the program error in logs
          const errLog = e.logs.find((l: string) =>
            l.includes("Error") || l.includes("failed")
          );
          msg = errLog || e.message || msg;
        } else if (e?.message) {
          msg = e.message;
        }
        console.error("Swap error:", e);
        setError(msg);
      }
      setPending(false);
    },
    [connection, publicKey, sendTransaction]
  );

  return { swap, pending, lastTx, error };
}
