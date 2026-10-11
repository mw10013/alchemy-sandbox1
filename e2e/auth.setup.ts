import * as Schema from "effect/Schema";
import { EmailFromInput } from "../src/api/backend.ts";
import { control, test as setup } from "./fixtures.ts";
import { followMagicLink } from "./screens.ts";

/** "reset data" must finish before any sign-in; `fullyParallel` would otherwise spread them. */
setup.describe.configure({ mode: "serial" });

setup("reset data", async ({ backend }) => {
  await backend(control((c) => c.ResetData()));
});

for (const [role, email] of [
  ["admin", "a@a.com"],
  ["member", "m1@m.com"],
] as const)
  setup(`sign in ${role}`, async ({ backend, page }) => {
    const { link } = await backend(
      control((c) => c.IssueMagicLink({ email: Schema.decodeUnknownSync(EmailFromInput)(email) })),
    );
    await followMagicLink(page, link);
    await page.waitForURL(role === "admin" ? /\/admin$/ : /\/app$/);
    await page.context().storageState({ path: `playwright/.auth/${role}.json` });
  });
