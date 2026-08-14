import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        navy: "#1F2937",
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
