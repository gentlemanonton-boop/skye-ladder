# Security Notes — Skye Ladder Frontend

This file documents accepted-risk dependency vulnerabilities and the
infrastructure-level mitigations that compensate for them. **Read this
before "fixing" anything `npm audit` reports** — most of the findings
are false positives whose suggested fixes would brick the app.

Last reviewed: 2026-04-08
Helius API key last rotated: 2026-04-08
Helius plan: Developer (paid) — RPC Access Control Rules enforced
Helius referrer allowlist: skyefall.gg, www.skyefall.gg

---

## TL;DR

`npm audit` shows 29 vulnerabilities (6 high, 2 moderate, 21 low) in
`frontend/`, and a similar set at the repo root. **Every single one of
the highs** has been investigated and is either:

- A transitive dependency we cannot upgrade away from without losing
  Token-2022 support entirely (the "fix" is a destructive downgrade), OR
- Already at the latest upstream version with no fix available

The real-world exploitability of all of them is **very low** in our
deployment context, and infrastructure-level mitigations (Helius
referrer restriction + usage cap) cover the realistic attack surface.

**Do not run `npm audit fix --force`.** It will downgrade
`@solana/spl-token` and break the entire app.

---

## Per-vulnerability accepted risks

### 1. `bigint-buffer` — Buffer Overflow via `toBigIntLE()` (high, ×4 paths)

**Where it lives:**
```
@solana/spl-token
  └── @solana/buffer-layout-utils
        └── bigint-buffer  ← vulnerable
```

Pulled in by `@solana/spl-token` (latest, 0.4.x) which we use for
every token operation in the frontend (balance reads, transfers, ATAs,
the whole Token-2022 flow).

**What the vulnerability is:** the `toBigIntLE()` function in
`bigint-buffer` doesn't bounds-check its input slice properly. An
attacker who can deliver a crafted byte buffer to be parsed as a
little-endian BigInt could cause an out-of-bounds read.

**Where the bytes come from in our app:** every buffer parsed by
`bigint-buffer` originates in a Solana RPC response (account data,
transaction instructions, token amounts). The bytes themselves come
from the Solana cluster.

**Realistic attack path:** an attacker would have to compromise our
Helius RPC endpoint (or man-in-the-middle the HTTPS connection) to
serve crafted data. Helius is a paid managed service with their own
hardening; HTTPS prevents the MITM. **Practical risk: near-zero.**

**The npm-suggested "fix":** downgrade `@solana/spl-token` to 0.1.8
(from 2021). Version 0.1.8 predates Token-2022 entirely. Applying it
would break:
- Reading SKYE balances (it's Token-2022)
- Trading on the curve (Token-2022 transfers)
- Token-2022 transfer hook integration (the entire Skye Ladder unlock
  enforcement)
- New token launches
- Basically every code path in the app

**Verdict:** ❌ DO NOT APPLY. This is the textbook example of a
false-positive npm audit finding where the cure is worse than the
disease.

**What to watch for:** the real fix will come when one of these lands:
- `@solana/web3.js` v2.x stabilizes (currently in long beta) and
  Solana publishes new SPL token packages built on it
- `solana-foundation` patches `@solana/buffer-layout-utils` to drop
  the `bigint-buffer` dependency in favor of native `BigInt` parsing
- A direct `bigint-buffer` security release lands and the upstream
  bumps to it

Re-run `npm audit` monthly and check whether any of the affected
packages have new versions that break this dep chain.

---

### 2. `@irys/upload-solana` chain — same `bigint-buffer` issue (high, ×2 paths)

**Where it lives:**
```
@metaplex-foundation/umi-uploader-irys (we're on 1.5.0 — latest)
  └── @irys/web-upload-solana
        └── @irys/upload-solana
              └── bigint-buffer  ← same vulnerable package
```

Pulled in by the Arweave metadata uploader we use in `LaunchTab.tsx`
to upload token images and metadata JSON when launching a new coin.
Dynamically imported, so it only loads in the launch flow.

**What npm suggests:** downgrade `@metaplex-foundation/umi-uploader-irys`
to 0.9.2. We're already on **1.5.0**, the latest stable. The "fix" is
6 major versions backward — loses major API improvements and would
likely break our `metadataService.ts` integration entirely.

**Realistic attack path:** same as #1 (would need to deliver crafted
bytes via the Irys / Solana network). Even less interesting because
metadata uploads only happen when the user is actively launching their
own token.

**Verdict:** ❌ DO NOT APPLY. Already on latest, downgrade is destructive.

**What to watch for:** when Metaplex releases a `umi-uploader-irys`
2.x that uses a non-vulnerable Irys SDK, this clears automatically.

---

### 3. `vite` / `esbuild` — Dev server SSRF (moderate, ×2)

**Where it lives:**
```
vite (currently 5.x)
  └── esbuild
```

**What the vulnerability is:** when you run `npm run dev`, Vite starts
a local dev server. The dev server's CORS is permissive — any website
you visit in the same browser can issue requests to it and read
responses. If the dev server is serving files with secrets in them
(like an `.env` mistakenly bundled into a HMR response), an attacker
website could exfiltrate them.

**Realistic risk:** affects YOU only when you have `npm run dev`
running locally. Does not affect deployed users. The deployed
production bundle does not use the dev server.

**What npm suggests:** bump to `vite@8.0.7` (`npm audit fix --force`).
Marked as breaking change. Vite 5 → 8 sometimes breaks build configs,
plugin compatibility, and Node version requirements.

**Verdict:** ⚠️ FIX EVENTUALLY but not in a normal session. Worth
trying in a dedicated branch where you can verify `npm run dev` and
`npm run build` both still work end-to-end before merging.

**Workaround in the meantime:** when running `npm run dev`, don't
browse to untrusted websites in the same browser session. Use a
separate browser profile if you're paranoid.

---

### 4. The 21 low-severity findings — `@ethersproject/*` and similar

Mostly speculative DoS or signature-malleability issues in
`@ethersproject/*` packages that we don't even use directly — they
come in transitively from `@meteora-ag/dlmm` and similar. The
ethers tree is being deprecated in favor of ethers v6 and these will
eventually clear when the Solana tooling drops the old transitive deps.

**Verdict:** ❌ NOT WORTH ANYONE'S TIME. Cosmetic. Re-check yearly.

---

## Real security improvements (do these instead of `npm audit fix`)

### A. Lock down the Helius RPC API key

The Helius API key is currently embedded in `frontend/.env.local` as
`VITE_RPC_URL=https://mainnet.helius-rpc.com/?api-key=...`. Vite
inlines this into the production bundle, which means **anyone visiting
skyefall.gg can extract it from the JS bundle** and use it against
your Helius quota.

**Steps in the Helius dashboard (https://dashboard.helius.dev):**

1. Find the API key currently in use. (You can confirm which one by
   opening `frontend/.env.local` — the value after `?api-key=`.)
2. **Settings → Access Control / Restrictions**
   - Set "HTTP Referrer" allowlist to:
     ```
     https://skyefall.gg
     https://www.skyefall.gg
     ```
   - Reject all other referrers. This stops scrapers from using your
     key on their own sites.
3. **Settings → Usage Limits**
   - Set a hard monthly cap based on your budget. Even $10/month is
     enough to prevent runaway billing if someone does manage to abuse
     the key.
4. **Optional: rotate the key.** It's been in plaintext in
   `.env.local` (gitignored, but on your filesystem) for a while. If
   any backup, sync tool, or screen-share captured it, the old value
   could be in someone's logs. Rotation costs nothing.

This single change is worth more security-wise than every npm audit
fix combined.

### B. Avoid `npm audit fix --force` permanently

Add a note to your run-commands cheatsheet (or a git pre-push hook) so
nobody on the project ever runs this command unwittingly. The downgrade
behavior is silent and the resulting broken app would only manifest
when a user tries to read a balance.

If you ever genuinely need to update dependencies, do it explicitly:
```
npm install <package>@<version>
npm run build  # verify nothing exploded
```

### C. Re-run this audit on a schedule

Quarterly is fine. Re-read this file FIRST, then run:
```
cd frontend && npm audit
```

Compare the output to what's documented above. If new vulnerabilities
appear that are NOT in this file, investigate them properly. If only
the documented ones are present, no action needed — the file is
the answer.

---

## What to do when an upstream fix actually lands

The two real fixes you're waiting on:

1. **`@solana/web3.js` v2 stable + new spl-token built on it.** Watch
   the [solana-labs/solana-web3.js](https://github.com/anza-xyz/solana-web3.js)
   releases page. When they tag a 2.0.0 stable, the spl-token
   ecosystem will follow within weeks. Bump both packages and re-run
   `npm audit` — the bigint-buffer chain should clear.

2. **`@metaplex-foundation/umi-uploader-irys` 2.x.** Watch the
   [Metaplex Foundation umi releases](https://github.com/metaplex-foundation/umi).
   Should be safe to bump as a normal version update once available.

When either of these lands, the corresponding section above can be
deleted from this file.
