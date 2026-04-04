#!/usr/bin/env bash
# Verifiable build & on-chain verification for Skye Ladder programs.
#
# Prerequisites:
#   cargo install solana-verify
#   docker (required for deterministic builds)
#
# Usage:
#   ./scripts/verify-programs.sh build    # Build verifiable .so files
#   ./scripts/verify-programs.sh verify   # Verify deployed programs match source
#   ./scripts/verify-programs.sh publish  # Publish verification to on-chain registry

set -eo pipefail

REPO="https://github.com/gentlemanonton-boop/skye-ladder"

# Program names and IDs from Anchor.toml [programs.mainnet]
NAMES=("skye_ladder" "skye_amm" "skye_curve")
PIDS=("4THAwb6WSpDyyqMHnJL2VBjU7TCLfLLGC5jtuCiyX5Rz" "GRBvJRRJfV3CzRLocGcr3NTptWQpu1G4nW9Jpff5TFoX" "5bxtpbYgiMQMJcB1c2cWXGErsiRmAZeyRqRKCXoeZRXf")

CMD="${1:-build}"

case "$CMD" in
  build)
    echo "==> Building verifiable .so files (Docker required)..."
    for name in "${NAMES[@]}"; do
      echo "--- Building $name ---"
      solana-verify build \
        --library-name "$name" \
        --base-image solanafoundation/solana-verifiable-build:2.1.0
    done
    echo "==> Verifiable builds complete. Check target/deploy/"
    ;;

  verify)
    echo "==> Verifying deployed programs against source..."
    for i in "${!NAMES[@]}"; do
      name="${NAMES[$i]}"
      pid="${PIDS[$i]}"
      echo "--- Verifying $name ($pid) ---"
      solana-verify verify-from-repo \
        --program-id "$pid" \
        --library-name "$name" \
        --remote "$REPO" \
        --base-image solanafoundation/solana-verifiable-build:2.1.0 \
        || echo "WARN: $name verification failed or not yet deployed"
    done
    ;;

  publish)
    echo "==> Publishing verification to on-chain registry..."
    for i in "${!NAMES[@]}"; do
      name="${NAMES[$i]}"
      pid="${PIDS[$i]}"
      echo "--- Publishing $name ($pid) ---"
      solana-verify publish \
        --program-id "$pid" \
        --library-name "$name" \
        --remote "$REPO" \
        || echo "WARN: $name publish failed"
    done
    echo "==> Verification published. Phantom and explorers will pick this up."
    ;;

  *)
    echo "Usage: $0 {build|verify|publish}"
    exit 1
    ;;
esac
