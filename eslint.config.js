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
          "useQueue", "useQueueActions", "useHistory", "useSettings", "useStats", "useSubscriptions", "useService",
          "useMinuteClock", "MOD_KEY", "buttonVariants", "toast",
        ],
      }],
      // The design system (2.5): sizes come from the type scale in
      // tailwind.config.ts, and muted text is never faded below 80% — the
      // 40–70% variants failed contrast on the dark theme.
      "no-restricted-syntax": ["error",
        { selector: "Literal[value=/\\btext-\\[\\d+(px|rem)\\]/]", message: "Use the type scale (text-xs … text-2xl), not an arbitrary size." },
        { selector: "TemplateElement[value.raw=/\\btext-\\[\\d+(px|rem)\\]/]", message: "Use the type scale (text-xs … text-2xl), not an arbitrary size." },
        { selector: "Literal[value=/\\btext-muted-foreground.[1-7]0\\b/]", message: "Muted text stays at 80% or more: use text-muted-foreground or /80." },
        { selector: "TemplateElement[value.raw=/\\btext-muted-foreground.[1-7]0\\b/]", message: "Muted text stays at 80% or more: use text-muted-foreground or /80." },
      ],
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
