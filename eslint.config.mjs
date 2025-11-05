import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import importPlugin from "eslint-plugin-import";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default defineConfig([
  { ignores: [`**/dist_*/**`] },
  js.configs.recommended,
  tseslint.configs.recommended,
  prettier,
  {
    files: [`**/*.js`, `**/*.jsx`, `**/*.ts`, `**/*.tsx`],
    plugins: { import: importPlugin },
    rules: {
      semi: [`error`, `always`],
    },
  },

  // Backend
  {
    files: [
      `backend/**/*.ts`,
      `backend/**/*.tsx`,
      `backend/**/*.js`,
      `backend/**/*.jsx`,
    ],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: `module`,
      },
    },
  },

  // Frontend
  {
    files: [
      `frontend/**/*.js`,
      `frontend/**/*.jsx`,
      `frontend/**/*.ts`,
      `frontend/**/*.tsx`,
    ],
    extends: [
      reactHooks.configs[`recommended-latest`],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
]);