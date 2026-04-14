import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "-apple-system", "BlinkMacSystemFont", "sans-serif"],
        pixel: ["'Press Start 2P'", "monospace"],
      },
      letterSpacing: {
        tighter: "-0.04em",
        tight: "-0.025em",
      },
      colors: {
        skye: {
          50: "#ecfdf5",
          100: "#d1fae5",
          200: "#a7f3d0",
          300: "#6ee7b7",
          400: "#34d399",
          500: "#10b981",
          600: "#059669",
          700: "#047857",
        },
        ink: {
          primary: "#ffffff",
          secondary: "#a1a1aa",
          tertiary: "#71717a",
          faint: "#52525b",
          ghost: "#3f3f46",
        },
        surface: {
          0: "#09090b",
          1: "#18181b",
          2: "#27272a",
          3: "#3f3f46",
        },
      },
      boxShadow: {
        "up-sm": "0 -1px 2px rgba(0,0,0,0.1)",
        "card": "0 0 0 1px rgba(255,255,255,0.05), 0 2px 12px rgba(0,0,0,0.4)",
        "card-hover": "0 0 0 1px rgba(255,255,255,0.08), 0 8px 24px rgba(0,0,0,0.5)",
        "float": "0 16px 48px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.06)",
        "glow-sm": "0 0 12px rgba(16,185,129,0.15)",
        "glow": "0 0 32px rgba(16,185,129,0.12)",
        "inner-light": "inset 0 1px 0 rgba(255,255,255,0.04)",
      },
      borderRadius: {
        "3xl": "24px",
        "2xl": "20px",
        xl: "14px",
        lg: "10px",
      },
      animation: {
        "fade-in": "fadeIn 0.4s cubic-bezier(0.16,1,0.3,1)",
        "slide-up": "slideUp 0.4s cubic-bezier(0.16,1,0.3,1)",
        "scale-in": "scaleIn 0.3s cubic-bezier(0.16,1,0.3,1)",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideUp: {
          "0%": { opacity: "0", transform: "translateY(12px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        scaleIn: {
          "0%": { opacity: "0", transform: "scale(0.95)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
