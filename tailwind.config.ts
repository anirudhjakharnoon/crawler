import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        void: {
          950: "#04070a",
          900: "#050c09",
          800: "#07100b",
          700: "#0b1712",
        },
        ac: {
          DEFAULT: "#5cff9d",
          dim: "#2f9c66",
          glow: "#8bffc0",
          warn: "#ffcf5c",
          danger: "#ff5c7a",
        },
      },
      fontFamily: {
        mono: ["var(--font-jetbrains)", "JetBrains Mono", "ui-monospace", "monospace"],
        display: ["var(--font-space-grotesk)", "Space Grotesk", "sans-serif"],
      },
      keyframes: {
        scanline: {
          "0%": { transform: "translateY(-100%)" },
          "100%": { transform: "translateY(100%)" },
        },
        marquee: {
          "0%": { transform: "translateX(0%)" },
          "100%": { transform: "translateX(-50%)" },
        },
        "pulse-ring": {
          "0%": { transform: "scale(0.9)", opacity: "0.7" },
          "70%": { transform: "scale(1.6)", opacity: "0" },
          "100%": { transform: "scale(1.6)", opacity: "0" },
        },
        "node-pop": {
          "0%": { transform: "scale(0)", opacity: "0" },
          "60%": { transform: "scale(1.25)", opacity: "1" },
          "100%": { transform: "scale(1)", opacity: "1" },
        },
        "drift-x": {
          "0%": { transform: "translate3d(0,0,0)" },
          "100%": { transform: "translate3d(-40px, 20px, 0)" },
        },
        flicker: {
          "0%, 100%": { opacity: "1" },
          "45%": { opacity: "0.86" },
          "50%": { opacity: "0.97" },
        },
      },
      animation: {
        scanline: "scanline 6s linear infinite",
        marquee: "marquee 22s linear infinite",
        "pulse-ring": "pulse-ring 2.4s cubic-bezier(0.2,0.6,0.4,1) infinite",
        "node-pop": "node-pop 0.5s cubic-bezier(0.2,0.8,0.3,1.2) both",
        drift: "drift-x 14s ease-in-out infinite alternate",
        flicker: "flicker 4s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
