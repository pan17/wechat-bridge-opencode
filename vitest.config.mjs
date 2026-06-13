// vitest.config.mjs
//
// Vitest config: include all *.mjs files under src/__tests__/. The project
// does NOT use the .test. filename convention — tests live alongside source
// under src/__tests__/ and import from the compiled dist/ artifacts.
//
// Imports from dist/ mean a fresh `npm run build` is required before
// `npm test` if you've changed any .ts source. The `npm test` script does
// NOT chain the build; run `npm run build && npm test` manually when needed.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.mjs"],
    testTimeout: 20000,
  },
});