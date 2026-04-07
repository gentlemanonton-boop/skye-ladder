/**
 * Create treasury WSOL ATA so the curve and AMM can route fees there.
 * Run once after deploying treasury.
 */

import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction, SystemProgram } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction } from "@solana/spl-token";
import fs from "fs";
import path from "path";

const RPC = "https://api.mainnet-beta.solana.com";
const TREASURY = new PublicKey("5j5J5sMhwURJv1bdufDUypt29FeRnfv8GLpv53Cy1oxs");

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const payerKey = JSON.parse(fs.readFileSync(path.join(process.env.HOME!, ".config/solana/id.json"), "utf-8"));
  const payer = Keypair.fromSecretKey(new Uint8Array(payerKey));

  console.log("Payer:", payer.publicKey.toBase58());

  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, TREASURY, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  console.log("Treasury WSOL ATA:", ata.toBase58());

  const info = await connection.getAccountInfo(ata);
  if (info) {
    console.log("Already exists.");
    return;
  }

  const tx = new Transaction().add(
    createAssociatedTokenAccountInstruction(payer.publicKey, ata, TREASURY, NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)
  );

  const sig = await sendAndConfirmTransaction(connection, tx, [payer]);
  console.log("Created. Sig:", sig);
}

main().catch(console.error);
