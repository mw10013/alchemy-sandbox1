import * as Schema from "effect/Schema";
import { SEED_SHOP } from "../seed-shops.ts";
import { E2eEmail } from "../../src/contract/test-control.ts";
import { control, expect, test } from "./fixtures.ts";

test.use({ storageState: "playwright/.auth/admin.json" });

test("the admin sees the seed members with their shops", async ({ goto, page }) => {
  await goto("/admin/members");
  // `s-table` exposes the ARIA grid pattern (`grid`, `row`, `columnheader`, `gridcell`) on
  // elements inside its shadow root, with the headers and cells slotted in. A locator chained
  // from the grid searches its DOM descendants and `toHaveText` reads DOM text, and slotted
  // content is in neither, so these locators start at the page and assert accessible names,
  // which follow slots.
  await expect(page.getByRole("grid")).toBeVisible();
  const headers = page.getByRole("columnheader");
  await expect(headers).toHaveCount(3);
  for (const [index, name] of ["Shop", "Email", "Added"].entries())
    await expect(headers.nth(index)).toHaveAccessibleName(name);
  const literal = (text: string) => text.replaceAll(".", "\\.");
  for (const [shop, email] of [
    ["seed-shop.myshopify.com", "m1@m.com"],
    ["seed-shop.myshopify.com", "m2@m.com"],
    ["other-shop.myshopify.com", "m1@m.com"],
  ] as const)
    await expect(
      page.getByRole("row", {
        name: new RegExp(`^${literal(shop)} ${literal(email)} \\d{4}-\\d{2}-\\d{2}$`, "u"),
      }),
      // A row is `display: contents`, with no box of its own, so Playwright counts it hidden.
    ).toHaveCount(1);
});

test("a member added through test control is listed", async ({ backend, goto, page }) => {
  const email = Schema.decodeUnknownSync(E2eEmail)(`e2e-${test.info().testId}@e2e.test`);
  await backend(control((c) => c.AddMember({ shop: SEED_SHOP, email })));
  await goto("/admin/members");
  await expect(page.getByRole("gridcell", { name: email })).toBeVisible();
});
