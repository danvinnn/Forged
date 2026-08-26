import js from "@eslint/js";
import next from "@next/eslint-plugin-next";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

/**
 * Flat config built from the plugins directly, rather than from
 * `eslint-config-next`.
 *
 * `eslint-config-next` is still an eslintrc-format config and loads
 * `@rushstack/eslint-patch`, which refuses to start under ESLint 9.39:
 *
 *   Error: Failed to patch ESLint because the calling module was not recognized.
 *
 * So `npm run lint` has been dead, and `next build` has printed that line on
 * every build while succeeding anyway. `@next/eslint-plugin-next` is what that
 * config wraps and it ships a flat export, so using it directly drops the patch
 * and keeps the same Next rules.
 */
export default [
  {
    ignores: [".next/**", "node_modules/**", "next-env.d.ts", "tools/**", "scratchpad/**"]
  },
  js.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mjs"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
      globals: {
        console: "readonly",
        process: "readonly",
        fetch: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        AbortSignal: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        crypto: "readonly",
        btoa: "readonly",
        atob: "readonly",
        window: "readonly",
        document: "readonly",
        localStorage: "readonly",
        HTMLInputElement: "readonly",
        File: "readonly",
        FormData: "readonly",
        Request: "readonly",
        Response: "readonly",
        Headers: "readonly",
        React: "readonly"
      }
    },
    plugins: { "@typescript-eslint": tsPlugin, "@next/next": next },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...next.flatConfig.recommended.rules,
      ...next.flatConfig.coreWebVitals.rules,
      // TypeScript already reports these, and more precisely: the base rule
      // does not understand types, overloads or declaration merging.
      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }]
    }
  },

  // ---------------------------------------------------------------------------
  // Rules switched off where the flagged construct is the POINT of the code.
  //
  // Scoped per file and per rule, with the reason, rather than switched off
  // globally: a rule disabled everywhere stops being a rule, and a rule
  // disabled with no reason gets re-enabled by the next person who reads it.
  // ---------------------------------------------------------------------------
  {
    // These regexes exist to MATCH control characters, so that untrusted text
    // from a datasheet cannot carry a NUL or an escape into a CAD file. A lint
    // rule warning that a regex contains control characters is describing the
    // feature. `no-useless-escape` goes with it: the bracketed set is written
    // to be scannable by eye, and a sanitiser is the last place to make a
    // cosmetic edit to a regex.
    files: [
      "src/lib/emitters/altium/binary.ts",
      "src/lib/exporters.ts",
      "src/lib/extraction/models/prompt.ts",
      "src/lib/retrieval/filename.ts"
    ],
    rules: { "no-control-regex": "off", "no-useless-escape": "off" }
  },
  {
    // The irregular whitespace IS the test vector: it checks that a prompt
    // cannot smuggle instructions past the sanitiser using exotic spaces.
    files: ["src/lib/extraction/__tests__/prompt-injection.test.ts"],
    rules: { "no-irregular-whitespace": "off" }
  },
  {
    // `require` is deliberate here and cannot be an import. The air-gap guard
    // inspects the loaded module graph to prove no networked module was pulled
    // in, which means reaching the CommonJS cache on purpose.
    files: ["src/lib/retrieval/__tests__/airgap-guard.test.ts"],
    rules: { "@typescript-eslint/no-require-imports": "off" }
  },
  {
    // The image is a base64 data URI of a datasheet page this machine rendered
    // a moment ago. `next/image` optimises files it can fetch and cache; it can
    // do nothing with a data URI, and routing through it would add a loader for
    // no benefit. Air-gapped mode also forbids the remote optimiser outright.
    files: ["src/app/page.tsx"],
    rules: { "@next/next/no-img-element": "off" }
  }
];
