import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "src-tauri", "test-results", "playwright-report"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Fast refresh is a dev-only nicety. These files deliberately export a
      // hook, constant or helper beside their component (a context provider
      // and its hook; shadcn's buttonVariants; sonner's toast), and splitting
      // them would churn imports across the app for no user-facing gain.
      "react-refresh/only-export-components": ["warn", {
        allowConstantExport: true,
        allowExportNames: [
          "useQueue", "useHistory", "useSettings", "useStats", "useSubscriptions", "useService",
          "useMinuteClock", "MOD_KEY", "buttonVariants", "toast",
        ],
      }],
      // `_`-prefixed names are deliberate discards (e.g. destructuring a
      // field out of an object before persisting the rest).
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrors: "none",
        ignoreRestSiblings: true,
      }],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-require-imports": "off",
      "no-empty": ["error", { "allowEmptyCatch": true }],
    },
  },
);
