import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // `navy` and `brand` below are the ORIGINAL application tokens, used
        // throughout the existing dashboard. They are deliberately left
        // untouched - redefining them to match the new marketing palette
        // would silently restyle every already-shipped dashboard screen.
        navy: "#1F2937",
        // The marketing/brand palette, sampled from the JobProfitAI logo:
        // deep navy wordmark, blue chart bars, green growth arrow.
        jp: {
          ink: "#0F1F4B", // darkest navy - headings
          navy: "#12275C", // logo wordmark navy
          blue: "#1D4ED8", // primary action blue
          "blue-bright": "#2E86E8", // lighter logo bar blue
          green: "#16A34A", // logo arrow green
          "green-dark": "#128140",
          slate: "#4B5563", // body copy
          muted: "#6B7280", // secondary copy
          line: "#E5E7EB", // hairline borders
          surface: "#F7F9FC", // section backgrounds
          "surface-2": "#EEF3FA",
        },
        brand: {
          DEFAULT: "#2563EB",
          light: "#DBEAFE",
        },
        // Chart palette - validated categorical order + fixed status colors,
        // see the dataviz skill: run `validate_palette.js` before changing
        // any of these rather than eyeballing new hex values.
        chart: {
          1: "#2a78d6", // blue     - fixed slot order for categorical series (cost categories)
          2: "#eb6834", // orange
          3: "#1baf7a", // aqua
          4: "#eda100", // yellow
          5: "#e87ba4", // magenta
          6: "#008300", // green
          surface: "#fcfcfb",
          grid: "#e1e0d9",
          baseline: "#c3c2b7",
          muted: "#898781",
        },
        status: {
          good: "#0ca30c",
          warning: "#fab219",
          serious: "#ec835a",
          critical: "#d03b3b",
        },
      },
    },
  },
  plugins: [],
};
export default config;
