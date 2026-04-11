import { useState, useRef } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import {
  Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, NATIVE_MINT,
  ExtensionType, createInitializeMintInstruction, createInitializeMint2Instruction,
  createInitializeTransferHookInstruction,
  createAssociatedTokenAccountInstruction, createMintToInstruction,
  createSyncNativeInstruction,
  getMintLen, MINT_SIZE, getMinimumBalanceForRentExemptMint,
  getAssociatedTokenAddressSync, ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Program, AnchorProvider } from "@coral-xyz/anchor";
import { TransactionInstruction } from "@solana/web3.js";
import ladderIdl from "../idl/skye_ladder.json";
import { storeToken } from "../lib/launchStore";
import { SKYE_LADDER_PROGRAM_ID as SKYE_LADDER_ID, SKYE_CURVE_ID, DECIMALS, RPC_URL } from "../constants";
const DEFAULT_SUPPLY = 1_000_000_000;
const INITIAL_VIRTUAL_SOL = 30 * LAMPORTS_PER_SOL;
const LAUNCH_DISC = new Uint8Array([10,128,86,171,3,137,161,244]);
const TREASURY_WALLET = new PublicKey("5j5J5sMhwURJv1bdufDUypt29FeRnfv8GLpv53Cy1oxs");
const LAUNCH_FEE_LAMPORTS = 0.01 * LAMPORTS_PER_SOL;
const SWAP_DISC = new Uint8Array([248,198,158,145,225,117,135,200]);

// Skye AMM constants for the auto-prestage step that runs immediately after
// the launch tx. Every launched token gets its AMM pool created with fee
// routing already pointed at the treasury and an incinerator LP token ATA
// pre-created — the graduation relayer can then atomically migrate
// liquidity into this pool the moment realSol crosses 85.
const SKYE_AMM_ID = new PublicKey("GRBvJRRJfV3CzRLocGcr3NTptWQpu1G4nW9Jpff5TFoX");
const INCINERATOR = new PublicKey("1nc1nerator11111111111111111111111111111111");
const POOL_FEE_BPS = 100; // 1% — matches the curve's fee_bps for continuity
// Anchor discriminators for the AMM instructions, computed from
// sha256("global:<name>")[0..8]:
const INIT_POOL_DISC      = new Uint8Array([95,180,10,172,84,174,232,40]);

/** Build Metaplex CreateV1 instruction via UMI. Returns null if it fails. */
async function buildMetadataIxs(
  mintAddress: string,
  walletAdapter: any,
  tokenName: string,
  tokenSymbol: string,
): Promise<TransactionInstruction[] | null> {
  try {
    const { createUmi } = await import("@metaplex-foundation/umi-bundle-defaults");
    const { mplTokenMetadata, createV1, TokenStandard } = await import("@metaplex-foundation/mpl-token-metadata");
    const { walletAdapterIdentity } = await import("@metaplex-foundation/umi-signer-wallet-adapters");
    const { publicKey: umiPk, transactionBuilder } = await import("@metaplex-foundation/umi");
    const { toWeb3JsInstruction } = await import("@metaplex-foundation/umi-web3js-adapters");

    const SPL_TOKEN_2022_ID = umiPk("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

    const umi = createUmi(RPC_URL)
      .use(mplTokenMetadata())
      .use(walletAdapterIdentity(walletAdapter));

    const builder = createV1(umi, {
      mint: umiPk(mintAddress),
      name: tokenName,
      symbol: tokenSymbol,
      uri: "",
      sellerFeeBasisPoints: { basisPoints: 0n, identifier: "%" as const, decimals: 2 },
      tokenStandard: TokenStandard.Fungible,
      splTokenProgram: SPL_TOKEN_2022_ID,
    });

    const ixs = builder.getInstructions();
    return ixs.map(ix => toWeb3JsInstruction(ix));
  } catch (e) {
    console.error("Failed to build metadata instructions:", e);
    return null;
  }
}

export function LaunchTab() {
  const wallet = useWallet();
  const { publicKey, sendTransaction } = wallet;
  const { connection } = useConnection();
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const supply = DEFAULT_SUPPLY.toString();
  const [description, setDescription] = useState("");
  const [website, setWebsite] = useState("");
  const [twitter, setTwitter] = useState("");
  const [telegram, setTelegram] = useState("");
  const [discord, setDiscord] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [initialBuySol, setInitialBuySol] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ mint: string; curve: string } | null>(null);

  function handleImageSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { setError("Image must be under 5MB"); return; }
    setImageFile(file);
    const reader = new FileReader();
    reader.onload = () => setImagePreview(reader.result as string);
    reader.readAsDataURL(file);
  }

  async function handleLaunch() {
    if (!publicKey || !sendTransaction || !name || !symbol) return;
    setError(null);
    setResult(null);

    // Validate initial buy amount
    const initialBuySolNum = parseFloat(initialBuySol) || 0;
    if (initialBuySolNum > 2) {
      setError("Initial buy capped at 2 SOL");
      return;
    }

    const supplyNum = parseInt(supply) || DEFAULT_SUPPLY;
    const supplyRaw = BigInt(supplyNum) * BigInt(10 ** DECIMALS);
    const mintKeypair = Keypair.generate();
    const mint = mintKeypair.publicKey;

    try {
      const provider = new AnchorProvider(
        connection, { publicKey, signTransaction: null, signAllTransactions: null } as any, { commitment: "confirmed" }
      );
      const ladderProgram = new Program(ladderIdl as any, provider);

      // Local data URI for the launching browser's localStorage cache so the
      // creator sees their image instantly without waiting on the Arweave
      // gateway. The on-chain Metaplex metadata (created in TX 2 below) is
      // what every other device reads.
      let imageDataUri = "";
      if (imageFile) {
        const bytes = new Uint8Array(await imageFile.arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        imageDataUri = `data:${imageFile.type};base64,${btoa(binary)}`;
      }

      // Derive all PDAs. NOTE: no creator ATA — we mint the supply directly
      // into the curve's token reserve, skipping the round trip through the
      // launcher's wallet entirely. That eliminates the pause/transfer/unpause
      // dance the old flow needed (a Token-2022 hook fires on transfer, not
      // on mint_to).
      const [configPDA] = PublicKey.findProgramAddressSync([Buffer.from("config"), mint.toBuffer()], SKYE_LADDER_ID);
      const [extraMetasPDA] = PublicKey.findProgramAddressSync([Buffer.from("extra-account-metas"), mint.toBuffer()], SKYE_LADDER_ID);
      const [curvePDA] = PublicKey.findProgramAddressSync([Buffer.from("curve"), mint.toBuffer()], SKYE_CURVE_ID);
      const tokenReserve = getAssociatedTokenAddressSync(mint, curvePDA, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const solReserve = getAssociatedTokenAddressSync(NATIVE_MINT, curvePDA, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const [launchpadConfig] = PublicKey.findProgramAddressSync([Buffer.from("launchpad-config")], SKYE_CURVE_ID);
      const [curveWR] = PublicKey.findProgramAddressSync([Buffer.from("wallet"), curvePDA.toBuffer(), mint.toBuffer()], SKYE_LADDER_ID);

      // ══════════════════════════════════════════════════
      // TX 1: Launch token (1 approval)
      //
      // Single transaction that does ALL of the following:
      //   1. Pay the launch fee
      //   2. Create the Token-2022 mint with TransferHook extension
      //   3. Initialize the mint
      //   4. Initialize the Skye Ladder hook config + extra-account-metas PDA
      //   5. Create the curve's token reserve ATA (owner = curve PDA)
      //   6. Create the curve's WSOL reserve ATA  (owner = curve PDA)
      //   7. Mint full supply DIRECTLY into the curve token reserve
      //   8. Create the curve account (skye-curve launch_token)
      //   9. Create the curve's wallet record (skye-ladder)
      //
      // The instruction order matters: createATA must happen before mintTo
      // (mintTo's destination must already exist), and `initialize` must
      // happen after `initializeMint` (Anchor deserializes the mint as an
      // InterfaceAccount).
      // ══════════════════════════════════════════════════
      setStep(1);

      const extensions = [ExtensionType.TransferHook];
      const mintLen = getMintLen(extensions);
      const mintLamports = await connection.getMinimumBalanceForRentExemption(mintLen);

      const initIx = await (ladderProgram.methods as any)
        .initialize(tokenReserve, curvePDA)
        .accounts({ authority: publicKey, mint, config: configPDA, extraAccountMetaList: extraMetasPDA, systemProgram: SystemProgram.programId })
        .instruction();

      const launchData = Buffer.alloc(8 + 8 + 8 + 2);
      launchData.set(LAUNCH_DISC, 0);
      launchData.writeBigUInt64LE(supplyRaw, 8);
      launchData.writeBigUInt64LE(BigInt(INITIAL_VIRTUAL_SOL), 16);
      launchData.writeUInt16LE(100, 24);

      const launchTokenIx = {
        keys: [
          { pubkey: publicKey, isSigner: true, isWritable: true },
          { pubkey: mint, isSigner: false, isWritable: false },
          { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
          { pubkey: launchpadConfig, isSigner: false, isWritable: false },
          { pubkey: curvePDA, isSigner: false, isWritable: true },
          { pubkey: tokenReserve, isSigner: false, isWritable: false },
          { pubkey: solReserve, isSigner: false, isWritable: false },
          { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        programId: SKYE_CURVE_ID,
        data: launchData,
      };

      const wrIx = await (ladderProgram.methods as any).createWalletRecord()
        .accounts({ payer: publicKey, wallet: curvePDA, mint, walletRecord: curveWR, systemProgram: SystemProgram.programId }).instruction();

      const tx1 = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: TREASURY_WALLET, lamports: LAUNCH_FEE_LAMPORTS }),
        SystemProgram.createAccount({
          fromPubkey: publicKey, newAccountPubkey: mint,
          space: mintLen, lamports: mintLamports, programId: TOKEN_2022_PROGRAM_ID,
        }),
        createInitializeTransferHookInstruction(mint, publicKey, SKYE_LADDER_ID, TOKEN_2022_PROGRAM_ID),
        createInitializeMintInstruction(mint, DECIMALS, publicKey, null, TOKEN_2022_PROGRAM_ID),
        initIx,
        createAssociatedTokenAccountInstruction(publicKey, tokenReserve, curvePDA, mint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
        createAssociatedTokenAccountInstruction(publicKey, solReserve, curvePDA, NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
        createMintToInstruction(mint, tokenReserve, publicKey, supplyRaw, [], TOKEN_2022_PROGRAM_ID),
        launchTokenIx,
        wrIx,
      );
      tx1.feePayer = publicKey;
      tx1.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      tx1.partialSign(mintKeypair);
      const sig1 = await sendTransaction(tx1, connection);
      await connection.confirmTransaction(sig1, "confirmed");

      // ══════════════════════════════════════════════════
      // TX 2: Auto-prestage the AMM pool (1 approval)
      //
      // Creates the AMM pool, lp_mint, reserve ATAs, and incinerator LP ATA
      // for THIS token. After this lands, the graduation relayer can fire
      // graduate atomically the moment realSol >= 85 — no per-launch manual
      // ops, no out-of-band scripts. Mirrors scripts/prestage-skye-pool.ts
      // but inlined here so every launch through the launchpad gets the
      // same runway from day one.
      //
      // Wrapped in try/catch — a prestage failure does not abort the launch
      // (the token still trades on the curve, just won't auto-graduate).
      // Can be retried later via scripts/prestage-skye-pool.ts adapted to
      // the right mint.
      // ══════════════════════════════════════════════════
      setStep(2);
      try {
        const [poolPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("pool"), mint.toBuffer(), NATIVE_MINT.toBuffer()],
          SKYE_AMM_ID,
        );
        const [lpAuthority] = PublicKey.findProgramAddressSync(
          [Buffer.from("lp-authority"), poolPda.toBuffer()],
          SKYE_AMM_ID,
        );
        const lpMintKeypair = Keypair.generate();
        const skyeReserve = getAssociatedTokenAddressSync(
          mint, poolPda, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
        );
        const wsolReserve = getAssociatedTokenAddressSync(
          NATIVE_MINT, poolPda, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
        );
        const treasuryWsolAta = getAssociatedTokenAddressSync(
          NATIVE_MINT, TREASURY_WALLET, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
        );
        const incineratorLpAta = getAssociatedTokenAddressSync(
          lpMintKeypair.publicKey, INCINERATOR, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
        );

        const lpMintRent = await getMinimumBalanceForRentExemptMint(connection);

        // initialize_pool(fee_bps: u16) — args: 2 bytes
        const initPoolData = Buffer.alloc(8 + 2);
        initPoolData.set(INIT_POOL_DISC, 0);
        initPoolData.writeUInt16LE(POOL_FEE_BPS, 8);

        const initPoolIx = new TransactionInstruction({
          programId: SKYE_AMM_ID,
          data: initPoolData,
          keys: [
            { pubkey: publicKey,                   isSigner: true,  isWritable: true  },
            { pubkey: mint,                        isSigner: false, isWritable: false },
            { pubkey: NATIVE_MINT,                 isSigner: false, isWritable: false },
            { pubkey: poolPda,                     isSigner: false, isWritable: true  },
            { pubkey: skyeReserve,                 isSigner: false, isWritable: false },
            { pubkey: wsolReserve,                 isSigner: false, isWritable: false },
            { pubkey: lpMintKeypair.publicKey,     isSigner: false, isWritable: false },
            { pubkey: lpAuthority,                 isSigner: false, isWritable: false },
            { pubkey: TOKEN_2022_PROGRAM_ID,       isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID,            isSigner: false, isWritable: false },
            { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId,     isSigner: false, isWritable: false },
          ],
        });

        const tx2 = new Transaction();

        // Metaplex metadata — built via UMI for correct Token-2022 support.
        // Non-fatal: if it fails, pool setup still proceeds.
        if (wallet.wallet?.adapter) {
          const metaIxs = await buildMetadataIxs(mint.toBase58(), wallet.wallet.adapter, name, symbol);
          if (metaIxs) metaIxs.forEach(ix => tx2.add(ix));
        }

        tx2.add(
          SystemProgram.createAccount({
            fromPubkey:       publicKey,
            newAccountPubkey: lpMintKeypair.publicKey,
            lamports:         lpMintRent,
            space:            MINT_SIZE,
            programId:        TOKEN_PROGRAM_ID,
          }),
          createInitializeMint2Instruction(
            lpMintKeypair.publicKey,
            6,
            lpAuthority,
            lpAuthority,
            TOKEN_PROGRAM_ID,
          ),
          createAssociatedTokenAccountInstruction(
            publicKey, skyeReserve, poolPda, mint,
            TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
          ),
          createAssociatedTokenAccountInstruction(
            publicKey, wsolReserve, poolPda, NATIVE_MINT,
            TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
          ),
          initPoolIx,
          createAssociatedTokenAccountInstruction(
            publicKey, incineratorLpAta, INCINERATOR, lpMintKeypair.publicKey,
            TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
          ),
        );
        tx2.feePayer = publicKey;
        tx2.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        tx2.partialSign(lpMintKeypair);
        const sig2 = await sendTransaction(tx2, connection);
        await connection.confirmTransaction(sig2, "confirmed");
      } catch (prestageErr: any) {
        console.error("Auto-prestage failed:", prestageErr);
        setError(
          "Token launched but pool setup failed. Your token trades on the curve but cannot graduate to the AMM. Contact the team to fix this."
        );
        // Don't proceed to initial buy — the user needs to see this warning.
        // The token exists on-chain and trades on the curve, but without the
        // AMM pool the graduation relayer will skip it forever.
        setStep(0);
        return;
      }

      // ══════════════════════════════════════════════════
      // TX 3 (OPTIONAL): Initial buy (1 approval)
      // ══════════════════════════════════════════════════
      if (initialBuySolNum > 0) {
        setStep(3);
        try {
          const creatorATA = getAssociatedTokenAddressSync(mint, publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
          const userWsol = getAssociatedTokenAddressSync(NATIVE_MINT, publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
          const [buyerWR] = PublicKey.findProgramAddressSync([Buffer.from("wallet"), publicKey.toBuffer(), mint.toBuffer()], SKYE_LADDER_ID);

          const [wsolInfo, buyerWRInfo] = await Promise.all([
            connection.getAccountInfo(userWsol),
            connection.getAccountInfo(buyerWR),
          ]);

          const buyIxs: TransactionInstruction[] = [];
          buyIxs.push(createAssociatedTokenAccountInstruction(publicKey, creatorATA, publicKey, mint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
          if (!wsolInfo) buyIxs.push(createAssociatedTokenAccountInstruction(publicKey, userWsol, publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
          if (!buyerWRInfo) {
            buyIxs.push(await (ladderProgram.methods as any).createWalletRecord()
              .accounts({ payer: publicKey, wallet: publicKey, mint, walletRecord: buyerWR, systemProgram: SystemProgram.programId }).instruction());
          }

          const lamportsIn = Math.floor(initialBuySolNum * LAMPORTS_PER_SOL);
          buyIxs.push(
            SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: userWsol, lamports: lamportsIn }),
            createSyncNativeInstruction(userWsol, TOKEN_PROGRAM_ID),
          );

          const swapData = Buffer.alloc(8 + 8 + 8 + 1);
          swapData.set(SWAP_DISC, 0);
          swapData.writeBigUInt64LE(BigInt(lamportsIn), 8);
          swapData.writeBigUInt64LE(0n, 16);
          swapData[24] = 1;

          buyIxs.push(new TransactionInstruction({
            keys: [
              { pubkey: publicKey, isSigner: true, isWritable: true },
              { pubkey: curvePDA, isSigner: false, isWritable: true },
              { pubkey: mint, isSigner: false, isWritable: false },
              { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
              { pubkey: creatorATA, isSigner: false, isWritable: true },
              { pubkey: userWsol, isSigner: false, isWritable: true },
              { pubkey: tokenReserve, isSigner: false, isWritable: true },
              { pubkey: solReserve, isSigner: false, isWritable: true },
              { pubkey: getAssociatedTokenAddressSync(NATIVE_MINT, TREASURY_WALLET, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID), isSigner: false, isWritable: true },
              { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: configPDA, isSigner: false, isWritable: false },
              { pubkey: curveWR, isSigner: false, isWritable: true },
              { pubkey: buyerWR, isSigner: false, isWritable: true },
              { pubkey: curvePDA, isSigner: false, isWritable: false },
              { pubkey: SKYE_LADDER_ID, isSigner: false, isWritable: false },
              { pubkey: extraMetasPDA, isSigner: false, isWritable: false },
            ],
            programId: SKYE_CURVE_ID,
            data: swapData,
          }));

          const tx3 = new Transaction().add(...buyIxs);
          tx3.feePayer = publicKey;
          tx3.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
          const sig3 = await sendTransaction(tx3, connection);
          await connection.confirmTransaction(sig3, "confirmed");
        } catch (buyErr: any) {
          console.error("Initial buy failed (non-fatal):", buyErr);
          // Token is already launched — the initial buy is optional.
          // Don't reset the UI or block the success screen.
        }
      }

      // Store token metadata locally
      storeToken({
        mint: mint.toBase58(), name, symbol, image: imageDataUri, description,
        website, twitter, telegram, discord,
        curve: curvePDA.toBase58(), creator: publicKey.toBase58(),
        launchedAt: Math.floor(Date.now() / 1000),
      });

      setStep(4);
      setResult({ mint: mint.toBase58(), curve: curvePDA.toBase58() });

    } catch (e: any) {
      setError(e.message || "Launch failed");
      console.error("Launch error:", e);
      setStep(0);
    }
  }

  const stepLabels = [
    "",
    "Launching token...",
    "Pre-staging AMM pool...",
    "Buying initial position...",
    "Done!",
  ];
  const isLaunching = step > 0 && step < 4;

  return (
    <div className="space-y-6">
      <div className="glass p-5 sm:p-6 space-y-4">
        <h3 className="font-pixel text-[10px] text-skye-400 tracking-wider mb-4">Create coin</h3>

        {/* Phantom warning notice */}
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-3 flex items-start gap-2.5">
          <svg className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <div className="text-[11px] sm:text-[12px] text-amber-200/90">
            <span className="font-semibold text-amber-300">Heads up:</span> Phantom may show a "transaction may be unsafe" warning. This is a false positive — Skye's programs aren't verified by Blowfish yet. Click <span className="font-semibold text-amber-300">Approve anyway</span> to continue. Your funds and tokens are safe.
          </div>
        </div>

        {/* Image */}
        <div>
          <label className="text-[12px] font-medium text-ink-tertiary mb-2 block">Token Image</label>
          <div className="flex items-center gap-4">
            <div onClick={() => fileInputRef.current?.click()}
              className="w-20 h-20 rounded-xl bg-white/5 border-2 border-dashed border-white/10 hover:border-skye-500/30 flex items-center justify-center cursor-pointer transition-all overflow-hidden flex-shrink-0">
              {imagePreview ? <img src={imagePreview} alt="" className="w-full h-full object-cover" /> :
                <div className="text-center"><span className="text-[20px]">+</span><p className="text-[8px] text-ink-faint mt-0.5">Upload</p></div>}
            </div>
            <div className="text-[11px] text-ink-faint space-y-1">
              <p>PNG, JPG, or GIF</p>
              <p>Max 5MB, square recommended</p>
              {imageFile && <p className="text-skye-400">{imageFile.name}</p>}
            </div>
          </div>
          <input ref={fileInputRef} type="file" accept="image/*" onChange={handleImageSelect} className="hidden" />
        </div>

        {/* Name + Symbol */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[12px] font-medium text-ink-tertiary mb-1 block">Name</label>
            <input type="text" placeholder="My Token" value={name} onChange={e => setName(e.target.value)} disabled={isLaunching}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-[14px] text-ink-primary outline-none focus:border-skye-500/30 transition min-h-[44px]" />
          </div>
          <div>
            <label className="text-[12px] font-medium text-ink-tertiary mb-1 block">Symbol</label>
            <input type="text" placeholder="TKN" value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())} maxLength={10} disabled={isLaunching}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-[14px] text-ink-primary outline-none focus:border-skye-500/30 transition min-h-[44px]" />
          </div>
        </div>

        {/* Description */}
        <div>
          <label className="text-[12px] font-medium text-ink-tertiary mb-1 block">Description</label>
          <textarea placeholder="What's your token about?" value={description} onChange={e => setDescription(e.target.value)} disabled={isLaunching} rows={3}
            className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-[14px] text-ink-primary outline-none focus:border-skye-500/30 transition resize-none" />
        </div>

        {/* Supply — fixed */}
        <div>
          <label className="text-[12px] font-medium text-ink-tertiary mb-1 block">Total Supply</label>
          <div className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-[14px] text-ink-faint min-h-[44px]">
            {Number(supply).toLocaleString()} (fixed)
          </div>
        </div>

        {/* Socials */}
        <div>
          <label className="text-[12px] font-medium text-ink-tertiary mb-2 block">Social Links <span className="text-ink-faint">(optional)</span></label>
          <div className="grid grid-cols-2 gap-2">
            <input type="url" placeholder="Website" value={website} onChange={e => setWebsite(e.target.value)} disabled={isLaunching}
              className="bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-[12px] text-ink-primary outline-none focus:border-skye-500/30 transition min-h-[40px]" />
            <input type="text" placeholder="Twitter @" value={twitter} onChange={e => setTwitter(e.target.value)} disabled={isLaunching}
              className="bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-[12px] text-ink-primary outline-none focus:border-skye-500/30 transition min-h-[40px]" />
            <input type="text" placeholder="Telegram" value={telegram} onChange={e => setTelegram(e.target.value)} disabled={isLaunching}
              className="bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-[12px] text-ink-primary outline-none focus:border-skye-500/30 transition min-h-[40px]" />
            <input type="text" placeholder="Discord" value={discord} onChange={e => setDiscord(e.target.value)} disabled={isLaunching}
              className="bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-[12px] text-ink-primary outline-none focus:border-skye-500/30 transition min-h-[40px]" />
          </div>
        </div>

        {/* Initial buy */}
        <div>
          <label className="text-[12px] font-medium text-ink-tertiary mb-1 block">Initial Buy <span className="text-ink-faint">(optional, max 2 SOL)</span></label>
          <div className="relative">
            <input type="number" placeholder="0.0" value={initialBuySol} onChange={e => setInitialBuySol(e.target.value)} disabled={isLaunching}
              max="2" step="0.1"
              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 pr-14 text-[14px] text-ink-primary outline-none focus:border-skye-500/30 transition min-h-[44px]" />
            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-[12px] text-ink-faint">SOL</span>
          </div>
          <p className="text-[10px] text-ink-faint mt-1">Buy in at launch — keeps the chart from being empty</p>
        </div>

        {/* Info */}
        <div className="grid grid-cols-3 gap-2 text-[11px]">
          <div className="bg-white/3 rounded-lg px-3 py-2 border border-white/5"><span className="text-ink-faint">Restrictions</span><p className="text-skye-400 font-semibold mt-0.5">5-Phase</p></div>
          <div className="bg-white/3 rounded-lg px-3 py-2 border border-white/5"><span className="text-ink-faint">Graduation</span><p className="text-skye-400 font-semibold mt-0.5">85 SOL</p></div>
          <div className="bg-white/3 rounded-lg px-3 py-2 border border-white/5"><span className="text-ink-faint">Pricing</span><p className="text-ink-secondary font-semibold mt-0.5">Bonding Curve</p></div>
        </div>

        {/* Progress */}
        {isLaunching && (
          <div className="bg-skye-500/10 border border-skye-500/20 rounded-xl p-4 space-y-2">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-skye-400 animate-pulse" />
              <span className="font-pixel text-[9px] text-skye-400">{stepLabels[step]}</span>
            </div>
            <div className="flex gap-1">
              {[1,2].map(s => <div key={s} className={`h-1 flex-1 rounded-full ${s <= step ? "bg-skye-500" : "bg-white/5"}`} />)}
            </div>
            <p className="text-[11px] text-ink-faint">Approve in wallet</p>
          </div>
        )}

        {/* Button */}
        {publicKey ? (!isLaunching ? (
          <button onClick={handleLaunch} disabled={!name || !symbol}
            className="w-full py-4 rounded-xl bg-gradient-to-r from-skye-500 to-skye-600 hover:from-skye-600 hover:to-skye-700 text-white font-semibold text-[15px] transition-all active:scale-[0.98] disabled:opacity-40 min-h-[52px]">
            Create coin
          </button>
        ) : null) : (
          <div className="text-center text-[13px] text-ink-faint py-3">Connect wallet to launch</div>
        )}

        {result && (
          <div className="bg-skye-500/10 border border-skye-500/20 rounded-xl p-4 space-y-3">
            <p className="font-pixel text-[9px] text-skye-400">TOKEN LAUNCHED</p>
            <p className="text-[12px] text-ink-secondary">Mint: <span className="text-ink-primary break-all">{result.mint}</span></p>
            <a href={`https://solscan.io/token/${result.mint}`} target="_blank" rel="noopener noreferrer"
              className="text-[12px] text-skye-400 hover:underline font-semibold">View on Solscan</a>

          </div>
        )}
        {error && <p className="text-center text-[12px] text-rose-400 break-all">{error}</p>}
      </div>

      {/* How it works */}
      <div className="glass p-5 sm:p-6">
        <h3 className="font-pixel text-[10px] text-amber-400 tracking-wider mb-4">HOW IT WORKS</h3>
        <div className="space-y-2">
          {[
            { s: "01", t: "Fill in token details, upload image, add socials", c: "text-skye-400" },
            { s: "02", t: "Metadata + tokenomics uploaded to Arweave permanently", c: "text-lime-400" },
            { s: "03", t: "Token launches on bonding curve — price rises with buys", c: "text-emerald-400" },
            { s: "04", t: "Sell restrictions active from day one via Transfer Hook", c: "text-cyan-400" },
            { s: "05", t: "At 85 SOL, liquidity migrates to Skye AMM pool", c: "text-purple-400" },
          ].map((s) => (
            <div key={s.s} className="flex items-center gap-3 bg-white/3 rounded-xl px-4 py-3 border border-white/5">
              <span className={`font-pixel text-[9px] ${s.c}`}>{s.s}</span>
              <span className="text-[13px] text-ink-secondary">{s.t}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="h-2 rounded-full overflow-hidden" style={{ background: "repeating-linear-gradient(90deg, rgba(34,197,94,0.3) 0px, rgba(34,197,94,0.3) 4px, transparent 4px, transparent 8px)" }} />
    </div>
  );
}
