const { defineConfig, globalIgnores } = require("eslint/config");
const js = require("@eslint/js");
const tseslint = require("typescript-eslint");
const angular = require("@angular-eslint/eslint-plugin");
const angularTemplate = require("@angular-eslint/eslint-plugin-template");
const templateParser = require("@angular-eslint/template-parser");
const globals = require("globals");

module.exports = defineConfig(
  globalIgnores(["**/dist/**", "**/.angular/**", "**/coverage/**"]),
  {
    files: ["eslint.config.cjs", ".github/scripts/**/*.cjs", "backend/tests/**/*.cjs"],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["backend/src/**/*.ts", "frontend/src/**/*.ts", "frontend/vitest-base.config.mts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      }],
    },
  },
  {
    files: ["backend/src/**/*.ts"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["frontend/src/**/*.ts"],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        project: ["./frontend/tsconfig.app.json", "./frontend/tsconfig.spec.json"],
        tsconfigRootDir: __dirname,
      },
    },
    plugins: { "@angular-eslint": angular },
    processor: angularTemplate.processors["extract-inline-html"],
    rules: {
      "@angular-eslint/contextual-lifecycle": "error",
      "@angular-eslint/no-duplicates-in-metadata-arrays": "error",
      "@angular-eslint/no-empty-lifecycle-method": "error",
      "@angular-eslint/no-input-rename": "error",
      "@angular-eslint/no-inputs-metadata-property": "error",
      "@angular-eslint/no-output-native": "error",
      "@angular-eslint/no-output-on-prefix": "error",
      "@angular-eslint/no-output-rename": "error",
      "@angular-eslint/no-outputs-metadata-property": "error",
      "@angular-eslint/no-uncalled-signals": "error",
      "@angular-eslint/use-pipe-transform-interface": "error",
    },
  },
  {
    files: ["frontend/src/**/*.spec.ts"],
    languageOptions: { globals: globals.vitest },
  },
  {
    files: ["frontend/src/**/*.html"],
    languageOptions: { parser: templateParser },
    plugins: { "@angular-eslint/template": angularTemplate },
    rules: {
      "@angular-eslint/template/banana-in-box": "error",
      "@angular-eslint/template/eqeqeq": "error",
      "@angular-eslint/template/no-negated-async": "error",
    },
  },
);
