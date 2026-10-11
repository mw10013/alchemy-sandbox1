import { SANDBOX_SHOP } from "../src/api/shop-actor.ts";
import { awaitHydration, expect, test } from "./fixtures.ts";
import { shop } from "./screens.ts";

test.use({ storageState: "playwright/.auth/member.json" });

test("an increment in one tab updates the count in another", async ({ context, goto, page }) => {
  const path = `/app/shop/${SANDBOX_SHOP}`;
  await goto(path);
  const other = await context.newPage();
  await other.goto(path);
  await awaitHydration(other);
  await expect(shop(other).activation).toBeVisible();
  // Relative: the e2e stage keeps the actor's storage under `.alchemy/` across runs.
  const before = Number(await shop(other).count.textContent());

  await shop(page).increment.click();

  await expect(shop(other).count).toHaveText(String(before + 1));
  await expect(shop(page).count).toHaveText(String(before + 1));
});
