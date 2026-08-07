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
      },
    },
  },
  plugins: [],
};
export default config;
