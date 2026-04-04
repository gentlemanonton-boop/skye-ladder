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

const wallets: any[] = [];

// Only autoConnect if user didn't explicitly disconnect
const shouldAutoConnect = !localStorage.getItem("wallet_disconnected");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConnectionProvider endpoint={RPC_URL}>
      <WalletProvider wallets={wallets} autoConnect={shouldAutoConnect}>
        <WalletModalProvider>
          <App />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  </React.StrictMode>
);
