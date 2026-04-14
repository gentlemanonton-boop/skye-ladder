import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      include: ["buffer", "stream", "events", "crypto", "util", "process"],
      globals: { Buffer: true, global: true, process: true },
    }),
  ],
  esbuild: {
    // Strip console.error/warn from production bundles — prevents leaking
    // internal state (RPC errors, stack traces) to browser devtools.
    pure: ["console.error", "console.warn"],
  },
  define: {
    "process.env": {},
    global: "globalThis",
  },
  resolve: {
    alias: {
      buffer: "buffer",
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      define: { global: "globalThis" },
    },
  },
});
