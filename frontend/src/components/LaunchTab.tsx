import { useState, useRef } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import {
  Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, NATIVE_MINT,
  ExtensionType, createInitializeMintInstruction, createInitializeTransferHookInstruction,
  createAssociatedTokenAccountInstruction, createMintToInstruction,
  createTransferCheckedInstruction,
  getMintLen, getAssociatedTokenAddressSync, ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Program, AnchorProvider } from "@coral-xyz/anchor";
import ladderIdl from "../idl/skye_ladder.json";
import { storeToken } from "../lib/launchStore";
import { uploadAndCreateMetadata } from "../lib/metadataService";
import { SKYE_LADDER_PROGRAM_ID as SKYE_LADDER_ID, SKYE_CURVE_ID, DECIMALS } from "../constants";
const DEFAULT_SUPPLY = 1_000_000_000;
const INITIAL_VIRTUAL_SOL = 30 * LAMPORTS_PER_SOL;
const LAUNCH_DISC = new Uint8Array([10,128,86,171,3,137,161,244]);
const TREASURY_WALLET = new PublicKey("5j5J5sMhwURJv1bdufDUypt29FeRnfv8GLpv53Cy1oxs");
const LAUNCH_FEE_LAMPORTS = 0.01 * LAMPORTS_PER_SOL;

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

    const supplyNum = parseInt(supply) || DEFAULT_SUPPLY;
    const supplyRaw = BigInt(supplyNum) * BigInt(10 ** DECIMALS);
    const mintKeypair = Keypair.generate();
    const mint = mintKeypair.publicKey;

    try {
      const provider = new AnchorProvider(
        connection, { publicKey, signTransaction: null, signAllTransactions: null } as any, { commitment: "confirmed" }
      );
      const ladderProgram = new Program(ladderIdl as any, provider);

      // Derive all PDAs
      const creatorATA = getAssociatedTokenAddressSync(mint, publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const [configPDA] = PublicKey.findProgramAddressSync([Buffer.from("config"), mint.toBuffer()], SKYE_LADDER_ID);
      const [extraMetasPDA] = PublicKey.findProgramAddressSync([Buffer.from("extra-account-metas"), mint.toBuffer()], SKYE_LADDER_ID);
      const [curvePDA] = PublicKey.findProgramAddressSync([Buffer.from("curve"), mint.toBuffer()], SKYE_CURVE_ID);
      const tokenReserve = getAssociatedTokenAddressSync(mint, curvePDA, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const solReserve = getAssociatedTokenAddressSync(NATIVE_MINT, curvePDA, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const [launchpadConfig] = PublicKey.findProgramAddressSync([Buffer.from("launchpad-config")], SKYE_CURVE_ID);
      const [curveWR] = PublicKey.findProgramAddressSync([Buffer.from("wallet"), curvePDA.toBuffer(), mint.toBuffer()], SKYE_LADDER_ID);

      // ══════════════════════════════════════════════════
      // TX 1: Create mint + mint supply + init hook (1 approval)
      // ══════════════════════════════════════════════════
      setStep(1);

      const extensions = [ExtensionType.TransferHook];
      const mintLen = getMintLen(extensions);
      const mintLamports = await connection.getMinimumBalanceForRentExemption(mintLen);

      const initIx = await (ladderProgram.methods as any)
        .initialize(tokenReserve, curvePDA)
        .accounts({ authority: publicKey, mint, config: configPDA, extraAccountMetaList: extraMetasPDA, systemProgram: SystemProgram.programId })
        .instruction();

      const tx1 = new Transaction().add(
        // Platform launch fee
        SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: TREASURY_WALLET, lamports: LAUNCH_FEE_LAMPORTS }),
        SystemProgram.createAccount({
          fromPubkey: publicKey, newAccountPubkey: mint,
          space: mintLen, lamports: mintLamports, programId: TOKEN_2022_PROGRAM_ID,
        }),
        createInitializeTransferHookInstruction(mint, publicKey, SKYE_LADDER_ID, TOKEN_2022_PROGRAM_ID),
        createInitializeMintInstruction(mint, DECIMALS, publicKey, null, TOKEN_2022_PROGRAM_ID),
        createAssociatedTokenAccountInstruction(publicKey, creatorATA, publicKey, mint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
        createMintToInstruction(mint, creatorATA, publicKey, supplyRaw, [], TOKEN_2022_PROGRAM_ID),
        initIx,
      );
      tx1.feePayer = publicKey;
      tx1.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      tx1.partialSign(mintKeypair);
      const sig1 = await sendTransaction(tx1, connection);
      await connection.confirmTransaction(sig1, "confirmed");

      // ══════════════════════════════════════════════════
      // STEP 2: Upload metadata to Arweave + create Metaplex account
      // ══════════════════════════════════════════════════
      setStep(2);

      let arweaveImageUri = "";
      try {
        arweaveImageUri = await uploadAndCreateMetadata({
          wallet: wallet as any,
          mint: mint.toBase58(),
          name,
          symbol,
          description,
          imageFile,
        });
      } catch (metaErr: any) {
        // Non-fatal — token still works without Metaplex metadata
        console.warn("Metadata upload failed (non-fatal):", metaErr);
      }

      // ══════════════════════════════════════════════════
      // TX 3: Create ATAs + launch curve + WalletRecord (1 approval)
      // ══════════════════════════════════════════════════
      setStep(3);

      const launchData = Buffer.alloc(8 + 8 + 8 + 2);
      launchData.set(LAUNCH_DISC, 0);
      launchData.writeBigUInt64LE(supplyRaw, 8);
      launchData.writeBigUInt64LE(BigInt(INITIAL_VIRTUAL_SOL), 16);
      launchData.writeUInt16LE(100, 24);

      const wrIx = await (ladderProgram.methods as any).createWalletRecord()
        .accounts({ payer: publicKey, wallet: curvePDA, mint, walletRecord: curveWR, systemProgram: SystemProgram.programId }).instruction();

      const tx2 = new Transaction().add(
        createAssociatedTokenAccountInstruction(publicKey, tokenReserve, curvePDA, mint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
        createAssociatedTokenAccountInstruction(publicKey, solReserve, curvePDA, NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
        { keys: [
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
        ], programId: SKYE_CURVE_ID, data: launchData },
        wrIx,
      );
      tx2.feePayer = publicKey;
      tx2.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      const sig2 = await sendTransaction(tx2, connection);
      await connection.confirmTransaction(sig2, "confirmed");

      // ══════════════════════════════════════════════════
      // TX 4: Pause + transfer supply + unpause (1 approval)
      // ══════════════════════════════════════════════════
      setStep(4);

      const pauseIx = await (ladderProgram.methods as any).setPaused(true).accounts({ authority: publicKey, mint, config: configPDA }).instruction();
      const transferIx = createTransferCheckedInstruction(creatorATA, mint, tokenReserve, publicKey, supplyRaw, DECIMALS, [], TOKEN_2022_PROGRAM_ID);
      const unpauseIx = await (ladderProgram.methods as any).setPaused(false).accounts({ authority: publicKey, mint, config: configPDA }).instruction();

      const tx3 = new Transaction().add(pauseIx, transferIx, unpauseIx);
      tx3.feePayer = publicKey;
      tx3.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      const sig3 = await sendTransaction(tx3, connection);
      await connection.confirmTransaction(sig3, "confirmed");

      // Store token metadata locally (use Arweave image if available, else data URI)
      let localImageUri = arweaveImageUri;
      if (!localImageUri && imageFile) {
        const bytes = new Uint8Array(await imageFile.arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        localImageUri = `data:${imageFile.type};base64,${btoa(binary)}`;
      }

      storeToken({
        mint: mint.toBase58(), name, symbol, image: localImageUri, description,
        website, twitter, telegram, discord,
        curve: curvePDA.toBase58(), creator: publicKey.toBase58(),
        launchedAt: Math.floor(Date.now() / 1000),
      });

      setStep(5);
      setResult({ mint: mint.toBase58(), curve: curvePDA.toBase58() });

    } catch (e: any) {
      setError(e.message || "Launch failed");
      console.error("Launch error:", e);
      setStep(0);
    }
  }

  const stepLabels = ["", "Creating token + hook...", "Uploading metadata to Arweave...", "Setting up bonding curve...", "Transferring supply...", "Done!"];
  const isLaunching = step > 0 && step < 5;

  return (
    <div className="space-y-6">
      <div className="glass p-6 text-center space-y-3">
        <h2 className="font-pixel text-[14px] sm:text-[16px] text-skye-400 tracking-wide">LAUNCHPAD</h2>
        <p className="text-[14px] text-ink-secondary max-w-sm mx-auto">
          Launch a token with built-in sell restrictions. Every token gets the Skye Ladder.
        </p>
      </div>

      <div className="glass p-5 sm:p-6 space-y-4">
        <h3 className="font-pixel text-[10px] text-skye-400 tracking-wider mb-4">CREATE TOKEN</h3>

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
              {[1,2,3,4].map(s => <div key={s} className={`h-1 flex-1 rounded-full ${s <= step ? "bg-skye-500" : "bg-white/5"}`} />)}
            </div>
            <p className="text-[11px] text-ink-faint">Step {step} of 4{step === 2 ? "" : " — approve in wallet"}</p>
          </div>
        )}

        {/* Button */}
        {publicKey ? (!isLaunching ? (
          <button onClick={handleLaunch} disabled={!name || !symbol}
            className="w-full py-4 rounded-xl bg-gradient-to-r from-skye-500 to-skye-600 hover:from-skye-600 hover:to-skye-700 text-white font-semibold text-[15px] transition-all active:scale-[0.98] disabled:opacity-40 min-h-[52px]">
            Launch {symbol || "Token"}
          </button>
        ) : null) : (
          <div className="text-center text-[13px] text-ink-faint py-3">Connect wallet to launch</div>
        )}

        {result && (
          <div className="bg-skye-500/10 border border-skye-500/20 rounded-xl p-4 space-y-2">
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
