import { dev, expect, test, testEmail } from "./fixtures.ts";
import { E2E_SHOP, e2eFixture } from "./shop-fixture.ts";

test.use({ storageState: "playwright/.auth/admin.json" });

/**
 * Other specs add members to the same shop in parallel, so these assert that their own rows are
 * there, never how many rows there are.
 */
test("the admin sees the e2e fixture's members with their shop", async ({ goto, page }) => {
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
  for (const email of e2eFixture.members)
    await expect(
      page.getByRole("row", {
        name: new RegExp(`^${literal(E2E_SHOP)} ${literal(email)} \\d{4}-\\d{2}-\\d{2}$`, "u"),
      }),
      // A row is `display: contents`, with no box of its own, so Playwright counts it hidden.
    ).toHaveCount(1);
});

test("a member added to the shop is listed", async ({ backend, goto, page }) => {
  const email = testEmail("added");
  await backend(
    dev((c) =>
      c.AddToFixture({
        shop: E2E_SHOP,
        fixture: { members: [email], teams: [], workflows: [], orders: [] },
      }),
    ),
  );
  await goto("/admin/members");
  await expect(page.getByRole("gridcell", { name: email })).toBeVisible();
});
