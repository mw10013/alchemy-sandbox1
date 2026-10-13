import { defineConfig, loadEnv } from "vite-plus";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import cloudflare from "@alchemy.run/cloudflare-runtime/vite";
import { playwright } from "vite-plus/test/browser-playwright";
import { fileURLToPath } from "node:url";

const websitePort = (mode: string) => {
  const port = loadEnv(mode, process.cwd(), "WEBSITE_").WEBSITE_PORT;
  if (!port) throw new Error("WEBSITE_PORT is not set");
  return Number(port);
};

const browserStub = (file: string) =>
  fileURLToPath(new URL(`test/browser/stubs/${file}`, import.meta.url));

/**
 * Server-only modules that components reach through `backend-client.ts`, replaced for the
 * browser project. The app gets the same effect from the TanStack Start compiler, whose plugin
 * stops Vitest's browser runner from starting. Exact patterns, because a string key would also
 * capture `@tanstack/react-start/server`.
 */
const browserStubs = [
  { find: /^@tanstack\/react-start$/, replacement: browserStub("start.ts") },
  { find: /^@tanstack\/react-start\/server$/, replacement: browserStub("start-server.ts") },
  { find: /^cloudflare:workers$/, replacement: browserStub("cloudflare-workers.ts") },
];

export default defineConfig(({ command, mode, isPreview }) => {
  if (
    command === "serve" &&
    isPreview === false &&
    process.env.VITEST !== "true" &&
    process.env.VP_RUN !== "1"
  ) {
    throw new Error("Use `vp run dev` to start the project dev server.");
  }

  return {
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
    // Alchemy overrides this with an internal port behind its public proxy.
    server: command === "serve" ? { port: websitePort(mode), strictPort: true } : undefined,
    test: {
      passWithNoTests: true,
      projects: [
        { test: { name: "unit", include: ["src/**/*.test.ts"] } },
        {
          // Components and hooks in Chromium: a `.test.tsx` is a browser test, a `.test.ts` a
          // Node test, and the globs must not overlap because `vitest/browser` throws in Node.
          plugins: [react()],
          resolve: { alias: browserStubs },
          optimizeDeps: { include: ["react/jsx-dev-runtime"] },
          test: {
            name: "browser",
            include: ["src/**/*.test.tsx"],
            browser: {
              enabled: true,
              provider: playwright(),
              headless: true,
              instances: [{ browser: "chromium" }],
            },
          },
        },
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
  };
});
