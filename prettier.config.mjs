/** @typedef {import("prettier").Config} PrettierConfig */
/** @typedef {import("@trivago/prettier-plugin-sort-imports").PluginConfig} SortImportsConfig */

/** @type { PrettierConfig | SortImportsConfig } */
const config = {
  bracketSpacing: true,
  bracketSameLine: true,
  arrowParens: "always",
  printWidth: 180,
  singleQuote: false,
  jsxSingleQuote: false,
  semi: true,
  trailingComma: "all",
  tabWidth: 2,
  plugins: ["@trivago/prettier-plugin-sort-imports"],
  importOrder: ["^the-one-(.*)$", "<THIRD_PARTY_MODULES>", "^[./]"],
  importOrderSeparation: true,
  importOrderSortSpecifiers: true,
};

export default config;
