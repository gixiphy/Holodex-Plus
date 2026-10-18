import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = import.meta.url;

export default defineConfig({
  resolve: {
    alias: {
      "@utils": fileURLToPath(new URL("./src/utils/index.ts", root)),
      "@assets": fileURLToPath(new URL("./src/assets", root)),
      "@src": fileURLToPath(new URL("./src", root)),
      "@pages": fileURLToPath(new URL("./src/pages", root)),
      "@locales": fileURLToPath(new URL("./src/locales", root)),
    },
  },
  test: {
    include: ["tests/audio-lock/**/*.test.ts"],
    environment: "jsdom",
    environmentOptions: {
      jsdom: {
        url: "https://holodex.net/multiview",
      },
    },
    css: false,
    testTimeout: 5000,
    hookTimeout: 5000,
    teardownTimeout: 5000,
    restoreMocks: true,
  },
  cacheDir: fileURLToPath(new URL("./.cache/vitest", root)),
});
