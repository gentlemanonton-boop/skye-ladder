#!/bin/bash
# deploy-all.sh — One-command deployment of Skye Ladder
#
# Usage:
#   chmod +x scripts/deploy-all.sh
#   ./scripts/deploy-all.sh
#
# Prerequisites:
#   - Solana CLI configured (solana config set --url <cluster>)
#   - Wallet with ≥4 SOL
#   - Program built (target/deploy/skye_ladder.so exists)

set -euo pipefail

export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.avm/bin:$HOME/.cargo/bin:$PATH"

RPC_URL=$(solana config get | grep 'RPC URL' | awk '{print $NF}')
NETWORK_LABEL="$RPC_URL"

echo "═══════════════════════════════════════════════════════════════"
echo "  Skye Ladder — Full Deployment"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# Check prerequisites
echo "Checking prerequisites..."

if ! command -v solana &> /dev/null; then
    echo "  ERROR: solana CLI not found. Install from https://docs.solanalabs.com/cli/install"
    exit 1
fi

if ! command -v anchor &> /dev/null; then
    echo "  ERROR: anchor CLI not found. Install via: cargo install --git https://github.com/coral-xyz/anchor avm"
    exit 1
fi

WALLET=$(solana address)
BALANCE=$(solana balance | cut -d' ' -f1)
echo "  Wallet:  $WALLET"
echo "  Balance: $BALANCE SOL"
echo "  Network: $NETWORK_LABEL"

if ! [ -f "target/deploy/skye_ladder.so" ]; then
    echo ""
    echo "  Program not built. Building now..."
    anchor build
fi

echo ""
echo "  Program size: $(wc -c < target/deploy/skye_ladder.so) bytes"
echo ""

# Install npm deps if needed
if ! [ -d "node_modules" ]; then
    echo "Installing npm dependencies..."
    npm install
    echo ""
fi

# Step 1: Deploy program
echo "═══════════════════════════════════════════════════════════════"
echo "  Step 1: Deploy Program"
echo "═══════════════════════════════════════════════════════════════"
solana program deploy target/deploy/skye_ladder.so \
    --program-id target/deploy/skye_ladder-keypair.json \
    || echo "  (Program may already be deployed)"

echo ""

# Step 2: Create mint + initialize config
echo "═══════════════════════════════════════════════════════════════"
echo "  Step 2: Create Token-2022 Mint + Initialize Config"
echo "═══════════════════════════════════════════════════════════════"
npx ts-node scripts/deploy.ts

echo ""

# Step 3: Create pool + mint supply
echo "═══════════════════════════════════════════════════════════════"
echo "  Step 3: Create Pool + Mint Supply"
echo "═══════════════════════════════════════════════════════════════"
npx ts-node scripts/create-pool.ts

echo ""

# Step 4: Test the hook
echo "═══════════════════════════════════════════════════════════════"
echo "  Step 4: Test Transfer Hook"
echo "═══════════════════════════════════════════════════════════════"
npx ts-node scripts/test-hook.ts

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Deployment Complete!"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "  State saved to: scripts/.deploy-state.json"
echo "  Review it for all addresses."
