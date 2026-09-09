import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      // Allineate a tooling/eslint/base.mjs del repo d'origine: il codice
      // migrato usa `_` per gli scarti e le comma expression deliberatamente.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-unused-expressions": "off",
    },
  },
);
