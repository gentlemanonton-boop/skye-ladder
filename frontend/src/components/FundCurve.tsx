import { useState, useEffect } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync, getAccount, createTransferCheckedInstruction,
} from "@solana/spl-token";
import { Program, AnchorProvider } from "@coral-xyz/anchor";
import ladderIdl from "../idl/skye_ladder.json";
import { SKYE_MINT, SKYE_LADDER_PROGRAM_ID } from "../constants";
import { getCurvePDA, getConfigPDA } from "../lib/pda";

const SKYE_CURVE_ID = new PublicKey("5bxtpbYgiMQMJcB1c2cWXGErsiRmAZeyRqRKCXoeZRXf");

export function FundCurve() {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const [status, setStatus] = useState<string | null>(null);
  const [funded, setFunded] = useState<boolean | null>(null);
  const [step, setStep] = useState(0); // 0=check, 1=pausing, 2=transferring, 3=unpausing

  // Check if reserve is funded on mount
  useEffect(() => {
    const [curvePDA] = getCurvePDA();
    const tokenReserve = getAssociatedTokenAddressSync(SKYE_MINT, curvePDA, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    getAccount(connection, tokenReserve, "confirmed", TOKEN_2022_PROGRAM_ID)
      .then(a => setFunded(a.amount > 0n))
      .catch(() => setFunded(false));
  }, [connection]);

  if (!publicKey || funded === null || funded === true) return null;

  async function handleFund() {
    if (!publicKey || !sendTransaction) return;

    try {
      const [curvePDA] = getCurvePDA();
      const tokenReserve = getAssociatedTokenAddressSync(SKYE_MINT, curvePDA, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const userATA = getAssociatedTokenAddressSync(SKYE_MINT, publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const [configPDA] = getConfigPDA();

      const provider = new AnchorProvider(connection, { publicKey, signTransaction: null, signAllTransactions: null } as any, { commitment: "confirmed" });
      const ladderProgram = new Program(ladderIdl as any, provider);

      // Step 1: Pause
      setStep(1);
      setStatus("Pausing hook (approve tx 1/3)...");
      const pauseIx = await (ladderProgram.methods as any).setPaused(true).accounts({ authority: publicKey, mint: SKYE_MINT, config: configPDA }).instruction();
      const tx1 = new Transaction().add(pauseIx);
      tx1.feePayer = publicKey;
      tx1.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      const sig1 = await sendTransaction(tx1, connection);
      await connection.confirmTransaction(sig1, "confirmed");

      // Step 2: Transfer
      setStep(2);
      setStatus("Transferring tokens (approve tx 2/3)...");
      let userBalance = 0n;
      try {
        const acct = await getAccount(connection, userATA, "confirmed", TOKEN_2022_PROGRAM_ID);
        userBalance = acct.amount;
      } catch {}

      if (userBalance === 0n) {
        setStatus("No tokens to transfer. Unpausing...");
      } else {
        const tx2 = new Transaction().add(
          createTransferCheckedInstruction(userATA, SKYE_MINT, tokenReserve, publicKey, userBalance, 9, [], TOKEN_2022_PROGRAM_ID)
        );
        tx2.feePayer = publicKey;
        tx2.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        const sig2 = await sendTransaction(tx2, connection);
        await connection.confirmTransaction(sig2, "confirmed");
      }

      // Step 3: Unpause
      setStep(3);
      setStatus("Unpausing hook (approve tx 3/3)...");
      const unpauseIx = await (ladderProgram.methods as any).setPaused(false).accounts({ authority: publicKey, mint: SKYE_MINT, config: configPDA }).instruction();
      const tx3 = new Transaction().add(unpauseIx);
      tx3.feePayer = publicKey;
      tx3.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      const sig3 = await sendTransaction(tx3, connection);
      await connection.confirmTransaction(sig3, "confirmed");

      setStatus("Done! Token is now tradeable.");
      setFunded(true);
    } catch (e: any) {
      setStatus("Failed: " + (e.message || e));
      // Try to unpause if we paused but transfer failed
      if (step >= 1) {
        try {
          const [configPDA] = getConfigPDA();
          const provider = new AnchorProvider(connection, { publicKey, signTransaction: null, signAllTransactions: null } as any, { commitment: "confirmed" });
          const ladderProgram = new Program(ladderIdl as any, provider);
          const unpauseIx = await (ladderProgram.methods as any).setPaused(false).accounts({ authority: publicKey, mint: SKYE_MINT, config: configPDA }).instruction();
          const tx = new Transaction().add(unpauseIx);
          tx.feePayer = publicKey;
          tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
          await sendTransaction(tx, connection);
        } catch {}
      }
      setStep(0);
    }
  }

  return (
    <div className="glass p-4 text-center space-y-2">
      <p className="font-pixel text-[9px] text-amber-400">SETUP REQUIRED</p>
      <p className="text-[13px] text-ink-secondary">Token supply needs to be transferred to the bonding curve. 3 approvals needed.</p>
      <button onClick={handleFund} disabled={step > 0}
        className="px-6 py-2.5 rounded-lg bg-amber-500/80 hover:bg-amber-500 text-white font-semibold text-[13px] transition min-h-[44px] disabled:opacity-50">
        {step > 0 ? `Step ${step}/3...` : "Fund Curve"}
      </button>
      {status && <p className="text-[11px] text-ink-tertiary">{status}</p>}
    </div>
  );
}
