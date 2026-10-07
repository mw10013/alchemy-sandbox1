import { defineConfig } from "vite-plus";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import cloudflare from "@alchemy.run/cloudflare-runtime/vite";

export default defineConfig(({ mode }) => ({
  plugins:
    mode === "test"
      ? []
      : [
          // Alchemy injects this same plugin on deploy/dev; never instantiate it twice.
          process.env.ALCHEMY_CLOUDFLARE_VITE_INJECTED === "1"
            ? null
            : cloudflare({
                compatibilityDate: "2026-07-01",
                compatibilityFlags: ["nodejs_compat"],
              }),
          tanstackStart(),
          react(),
        ],
  server: { port: 3000, strictPort: true },
  test: { include: ["src/**/*.test.ts"] },
  fmt: { ignorePatterns: ["src/routeTree.gen.ts", "AGENTS.md", "refs/**"] },
  lint: {
    ignorePatterns: ["refs/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
}));
