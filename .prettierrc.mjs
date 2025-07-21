/**
 * @type {import('prettier').Options}
 */
export default {
  printWidth: 120,
  trailingComma: "es5",
  tabWidth: 2,
  semi: false,
  singleQuote: true,
  quoteProps: 'consistent',
  jsxSingleQuote: true,
  arrowParens: "avoid",
  endOfLine: "lf",
  plugins: ["@ianvs/prettier-plugin-sort-imports"],

  // @ianvs/prettier-plugin-sort-imports
  // https://github.com/IanVS/prettier-plugin-sort-imports
  importOrder: [
    '<BUILTIN_MODULES>',
    '^hono(\/.*)?',
    '<THIRD_PARTY_MODULES>',
    '@(?=[^\/]).*',
    '',
    '^@/types(.*)$',
    '',
    '^@/schema(.*)$',
    '',
    '^@/const(.*)$',
    '',
    '^@/lib(.*)$',
    '',
    '^@/utils(.*)$',
    '',
    '^@/hooks(.*)$',
    '',
    '^@/handlers(.*)$',
    '',
    '^@/components(.*)$',
    '',
    '^@/app(.*)$',
    '',
    '^@/pages(.*)$',
    '',
    '^[.]',
  ]
}
