import { Connection, PublicKey } from "@solana/web3.js";
const SKYE_MINT = new PublicKey("5GtUWP1x4LpKjAzGBZg9sy9TbTqjY2bvJfgfC7aUmAfF");
const SKYE_CURVE_ID = new PublicKey("5bxtpbYgiMQMJcB1c2cWXGErsiRmAZeyRqRKCXoeZRXf");
const PRICE_SCALE = 10n ** 18n;
const RPC = process.argv[2] || "https://api.mainnet-beta.solana.com";
(async () => {
  const conn = new Connection(RPC, "confirmed");
  const [curvePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("curve"), SKYE_MINT.toBuffer()],
    SKYE_CURVE_ID
  );
  const info = await conn.getAccountInfo(curvePDA);
  if (!info) { console.error("curve PDA not found:", curvePDA.toBase58()); process.exit(1); }
  const data = info.data;
  // test-phases.ts uses offsets 168/176 for the curve PDA
  const skye = data.readBigUInt64LE(168);
  const wsol = data.readBigUInt64LE(176);
  const priceScaled = (wsol * PRICE_SCALE) / skye;
  // Human form: SOL per token = wsol / skye, both u64 lamports vs raw tokens
  // skye has 9 decimals, sol has 9 decimals → ratio is direct in normal units
  const human = Number(wsol) / Number(skye);
  console.log("curvePDA:", curvePDA.toBase58());
  console.log("skye_amount:", skye.toString());
  console.log("wsol_amount:", wsol.toString());
  console.log("priceScaled (u64):", priceScaled.toString());
  console.log("price (SOL/token):", human.toFixed(20));
})().catch(e => { console.error(e); process.exit(1); });
