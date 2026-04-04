import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "-apple-system", "BlinkMacSystemFont", "sans-serif"],
        pixel: ["'Press Start 2P'", "monospace"],
      },
      colors: {
        skye: {
          50: "#f0fdf4",
          100: "#dcfce7",
          200: "#bbf7d0",
          300: "#86efac",
          400: "#4ade80",
          500: "#22c55e",
          600: "#16a34a",
          700: "#15803d",
        },
        ink: {
          primary: "#ffffff",
          secondary: "#f0f0f0",
          tertiary: "#e0e0e0",
          faint: "#c0c0c0",
        },
      },
    },
  },
  plugins: [],
};

export default config;
