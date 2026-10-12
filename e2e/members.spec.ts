import * as Schema from "effect/Schema";
import { SANDBOX_SHOP } from "../src/api/shop.ts";
import { E2eEmail } from "../src/api/test-control.ts";
import { control, expect, test } from "./fixtures.ts";

test.use({ storageState: "playwright/.auth/admin.json" });

test("the admin sees the seed members with their shops", async ({ goto, page }) => {
  await goto("/admin/members");
  const date = /\d{4}-\d{2}-\d{2}/;
  const table = page.getByRole("table");
  await expect(table.getByRole("columnheader")).toHaveText(["Shop", "Email", "Added"]);
  for (const [shop, email] of [
    ["alchemy-sandbox1.myshopify.com", "m1@m.com"],
    ["alchemy-sandbox1.myshopify.com", "m2@m.com"],
    ["other-shop.myshopify.com", "m1@m.com"],
  ] as const)
    await expect(
      table.getByRole("row").filter({ hasText: shop }).filter({ hasText: email }),
    ).toContainText(date);
});

test("a member added through test control is listed", async ({ backend, goto, page }) => {
  const email = Schema.decodeUnknownSync(E2eEmail)(`e2e-${test.info().testId}@e2e.test`);
  await backend(control((c) => c.AddMember({ shop: SANDBOX_SHOP, email })));
  await goto("/admin/members");
  await expect(page.getByRole("cell", { name: email })).toBeVisible();
});
