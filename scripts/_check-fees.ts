import { Connection, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";

const SKYE_MINT = new PublicKey("5GtUWP1x4LpKjAzGBZg9sy9TbTqjY2bvJfgfC7aUmAfF");
const SKYE_CURVE_ID = new PublicKey("5bxtpbYgiMQMJcB1c2cWXGErsiRmAZeyRqRKCXoeZRXf");
const SKYE_AMM_ID = new PublicKey("GRBvJRRJfV3CzRLocGcr3NTptWQpu1G4nW9Jpff5TFoX");
const TREASURY_WALLET = new PublicKey("5j5J5sMhwURJv1bdufDUypt29FeRnfv8GLpv53Cy1oxs");
const RPC = process.argv[2] || "https://api.mainnet-beta.solana.com";
const LAMPORTS = 1_000_000_000;

(async () => {
  const c = new Connection(RPC, "confirmed");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  SKYE Fee Audit");
  console.log("═══════════════════════════════════════════════════════════════\n");

  // ── 1. Curve PDA: reserves + graduated flag ──
  const [curvePDA] = PublicKey.findProgramAddressSync([Buffer.from("curve"), SKYE_MINT.toBuffer()], SKYE_CURVE_ID);
  const curveAcct = await c.getAccountInfo(curvePDA);
  if (!curveAcct) { console.error("✗ Curve PDA not found"); process.exit(1); }
  const skyeReserve = curveAcct.data.readBigUInt64LE(168);
  const wsolReserveCached = curveAcct.data.readBigUInt64LE(176);
  const realSol = curveAcct.data.readBigUInt64LE(184);
  const graduated = curveAcct.data[210] === 1;
  console.log("─── CURVE ────────────────────────────────────────────────");
  console.log(`  PDA:            ${curvePDA.toBase58()}`);
  console.log(`  Graduated?:     ${graduated ? "YES" : "NO"}`);
  console.log(`  SKYE reserves:  ${(Number(skyeReserve) / LAMPORTS).toFixed(2)} SKYE`);
  console.log(`  vSOL (virtual): ${(Number(wsolReserveCached) / LAMPORTS).toFixed(4)} SOL`);
  console.log(`  realSol:        ${(Number(realSol) / LAMPORTS).toFixed(4)} SOL  ← actual SOL inside curve (includes pool's 50% fee share)`);

  // ── 2. Treasury WSOL ATA ──
  const treasuryWsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, TREASURY_WALLET, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const treasuryAcct = await c.getAccountInfo(treasuryWsolAta);
  let treasuryBalance = 0n;
  if (treasuryAcct && treasuryAcct.data.length >= 72) {
    treasuryBalance = treasuryAcct.data.readBigUInt64LE(64);
  }
  // Native SOL balance of treasury wallet
  const treasuryLamports = await c.getBalance(TREASURY_WALLET);
  console.log("\n─── TREASURY (curve fee destination) ─────────────────────");
  console.log(`  Wallet:         ${TREASURY_WALLET.toBase58()}`);
  console.log(`  Native SOL:     ${(treasuryLamports / LAMPORTS).toFixed(4)} SOL`);
  console.log(`  WSOL ATA:       ${treasuryWsolAta.toBase58()}`);
  console.log(`  WSOL balance:   ${(Number(treasuryBalance) / LAMPORTS).toFixed(4)} SOL  ← 50% of every curve trade fee lands here`);

  // ── 3. AMM Pool (if graduated) ──
  console.log("\n─── AMM POOL (post-graduation, if any) ───────────────────");
  // Pool PDA seeds: [b"pool", skye_mint, wsol_mint]
  const [poolPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), SKYE_MINT.toBuffer(), NATIVE_MINT.toBuffer()],
    SKYE_AMM_ID
  );
  const poolAcct = await c.getAccountInfo(poolPDA);
  if (!poolAcct) {
    console.log(`  Pool PDA:       ${poolPDA.toBase58()}`);
    console.log(`  Status:         NOT INITIALIZED — SKYE has not graduated yet`);
  } else {
    // Pool struct (from state.rs):
    //   8  discriminator
    //   32 authority
    //   32 skye_mint
    //   32 wsol_mint
    //   32 skye_reserve
    //   32 wsol_reserve
    //   32 lp_mint
    //   8  skye_amount
    //   8  wsol_amount
    //   2  fee_bps
    //   1  bump
    //   1  lp_authority_bump
    //   32 team_wallet
    //   32 diamond_vault
    //   32 strong_vault
    const data = poolAcct.data;
    const skyeAmount = data.readBigUInt64LE(8 + 32*6);
    const wsolAmount = data.readBigUInt64LE(8 + 32*6 + 8);
    const feeBps = data.readUInt16LE(8 + 32*6 + 16);
    const teamWallet = new PublicKey(data.subarray(8 + 32*6 + 20, 8 + 32*6 + 52));
    const diamondVault = new PublicKey(data.subarray(8 + 32*6 + 52, 8 + 32*6 + 84));
    const strongVault = new PublicKey(data.subarray(8 + 32*6 + 84, 8 + 32*6 + 116));
    console.log(`  Pool PDA:       ${poolPDA.toBase58()}`);
    console.log(`  fee_bps:        ${feeBps} (${feeBps/100}%)`);
    console.log(`  SKYE reserves:  ${(Number(skyeAmount) / LAMPORTS).toFixed(2)}`);
    console.log(`  WSOL reserves:  ${(Number(wsolAmount) / LAMPORTS).toFixed(4)} SOL`);
    console.log(`  team_wallet:    ${teamWallet.toBase58()}  (50% of fees)`);
    console.log(`  diamond_vault:  ${diamondVault.toBase58()}  (17.5% of fees)`);
    console.log(`  strong_vault:   ${strongVault.toBase58()}  (7.5% of fees)`);

    // Try to read each vault's WSOL balance
    for (const [name, key] of [["team_wallet", teamWallet], ["diamond_vault", diamondVault], ["strong_vault", strongVault]] as const) {
      if (key.equals(PublicKey.default)) { console.log(`    ${name} balance: not configured`); continue; }
      const acct = await c.getAccountInfo(key);
      if (!acct) { console.log(`    ${name} balance: account does not exist`); continue; }
      // It might be a WSOL token account (data length 165) or a native wallet
      if (acct.data.length >= 72) {
        const bal = acct.data.readBigUInt64LE(64);
        console.log(`    ${name} WSOL: ${(Number(bal) / LAMPORTS).toFixed(4)} SOL`);
      } else {
        const lamports = acct.lamports;
        console.log(`    ${name} native: ${(lamports / LAMPORTS).toFixed(4)} SOL`);
      }
    }
  }
  console.log("\n═══════════════════════════════════════════════════════════════");
})().catch(e => { console.error(e); process.exit(1); });
