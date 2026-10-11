import { defineConfig, loadEnv } from "vite-plus";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import cloudflare from "@alchemy.run/cloudflare-runtime/vite";

const websitePort = (mode: string) => {
  const port = loadEnv(mode, process.cwd(), "WEBSITE_").WEBSITE_PORT;
  if (!port) throw new Error("WEBSITE_PORT is not set");
  return Number(port);
};

export default defineConfig(({ command, mode }) => ({
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
  // Only used by the app-only `vp dev` fallback; Alchemy serves the public port.
  server: command === "serve" ? { port: websitePort(mode), strictPort: true } : undefined,
  test: {
    passWithNoTests: true,
    projects: [
      { test: { name: "unit", include: ["src/**/*.test.ts"] } },
      {
        // Deploys the Backend in workerd through alchemy/Test; one file at a time, and
        // ALCHEMY_DEV is read by the Worker's init at plan, so the test process must set it.
        test: {
          name: "integ",
          include: ["test/integ/**/*.test.ts"],
          env: { ALCHEMY_DEV: "1" },
          testTimeout: 30_000,
          hookTimeout: 120_000,
          fileParallelism: false,
          pool: "forks",
        },
      },
    ],
  },
  fmt: { ignorePatterns: ["src/routeTree.gen.ts", "AGENTS.md", "refs/**"] },
  lint: {
    ignorePatterns: ["refs/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      // Effect is consumed one module at a time: `import * as Effect from "effect/Effect"`.
      // The root barrel drags all 160 modules through Vite dev and the Worker bundle.
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "effect",
              message: 'Import Effect modules by path: import * as Effect from "effect/Effect".',
            },
          ],
        },
      ],
    },
    options: { typeAware: true, typeCheck: true },
  },
}));
