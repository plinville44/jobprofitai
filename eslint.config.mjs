import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

// ESLint flat config.
//
// Two things made this file necessary in the Next.js 16 upgrade: `next lint`
// was removed, so `npm run lint` calls the ESLint CLI directly and needs a
// config of its own, and eslint-config-next 16 is flat-config native. Its
// package.json declares `"eslint": ">=9.0.0"` as a peer and exports
// ready-made flat config arrays from each subpath.
//
// Import them directly. Do NOT wrap these in FlatCompat: that helper exists
// to translate OLD eslintrc-style configs into flat ones, and feeding it a
// config that is already flat sends its validator into
// "Converting circular structure to JSON".
//
// Note that `next build` no longer runs lint at all in Next.js 16. Linting is
// now something you run deliberately, which means a lint failure cannot block
// a deploy, and equally that nothing will catch one for you.
const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "next-env.d.ts",
      "**/*.tsbuildinfo",
    ],
  },
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      // Warn, not error, and deliberately so.
      //
      // Most of the `any`s in this codebase are at a boundary where the type
      // genuinely isn't known: parsing QuickBooks API JSON, Recharts tooltip
      // formatter callbacks, and the in-memory Prisma double in the tests.
      // Fifty-odd unfixable errors is worse than none, because it teaches
      // you to run lint, see red, and stop reading. As a warning it stays
      // visible for the cases where a real type does exist.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    // The test double models a database, so it deals in loose row shapes on
    // purpose. Flagging that as a code-quality problem misreads the file.
    files: ["src/lib/__tests__/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
];

export default config;
