import { Buffer } from "buffer";
(window as any).Buffer = Buffer;

import React from "react";
import ReactDOM from "react-dom/client";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import App from "./App";
import { RPC_URL } from "./constants";
import "./index.css";

// Empty array = wallet-standard auto-detects installed wallets (Phantom, Solflare, etc.)
// This is the modern approach used by Jupiter — gives proper disconnect/reconnect with approval prompts
const wallets: any[] = [];

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConnectionProvider endpoint={RPC_URL}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <App />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  </React.StrictMode>
);
