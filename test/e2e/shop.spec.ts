import { awaitHydration, dev, expect, nextOpenSocket, ownMember, test } from "./fixtures.ts";
import type { Page } from "playwright/test";
import { shell, shop, signInWithForm } from "./screens.ts";
import { E2E_SHOP } from "./shop-fixture.ts";

test.use({ storageState: "playwright/.auth/member.json" });

/** Every test here reads or writes the one shop's count, so they take turns. */
test.describe.configure({ mode: "serial" });

const path = `/shop/${E2E_SHOP}`;

test("an increment in one window updates the count in another", async ({ context, goto, page }) => {
  await goto(path);
  const other = await context.newPage();
  await other.goto(path);
  await awaitHydration(other);
  await expect(shop(other).activation).toBeVisible();
  await expect(shop(page).signedInAs("m1@m.com")).toBeVisible();
  // Relative: the e2e stage keeps the actor's storage under `.alchemy/` across runs.
  const before = Number(await shop(other).count.textContent());

  await shop(page).increment.click();

  await expect(shop(other).count).toHaveText(String(before + 1));
  await expect(shop(page).count).toHaveText(String(before + 1));
});

test("sign-out in one window sends the other to sign-in; an admin is untouched", async ({
  backend,
  browser,
}) => {
  const { context, page } = await ownMember(browser, backend, "signout");
  await page.goto(path);
  await awaitHydration(page);
  const other = await context.newPage();
  const opened = nextOpenSocket(other);
  await other.goto(path);
  await awaitHydration(other);
  await opened;

  const adminContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const admin = await adminContext.newPage();
  await signInWithForm(admin, "a@a.com");
  await admin.waitForURL(/\/admin$/);

  await shell(page).signOut.click();

  await other.waitForURL(/\/sign-in/);
  await expect(admin).toHaveURL(/\/admin$/);
  await expect(shell(admin).signOut).toBeVisible();
  await adminContext.close();
  await context.close();
});

test("a member removed while the page is open is told so", async ({ backend, browser }) => {
  const { email, context, page } = await ownMember(browser, backend, "removed");
  const opened = nextOpenSocket(page);
  await page.goto(path);
  await awaitHydration(page);
  await opened;

  await backend(dev((c) => c.RemoveMember({ shop: E2E_SHOP, email })));

  await expect(shop(page).notAMember).toBeVisible();
  await context.close();
});

test("a third window displaces the oldest, and Reconnect there takes it back", async ({
  backend,
  browser,
}) => {
  const { context, page: first } = await ownMember(browser, backend, "displaced");
  const open = async (page: Page) => {
    const opened = nextOpenSocket(page);
    await page.goto(path);
    await awaitHydration(page);
    await opened;
    return page;
  };
  await open(first);
  const second = await open(await context.newPage());
  const third = await open(await context.newPage());

  await expect(shop(first).signedInElsewhere).toBeVisible();
  await expect(shop(second).signedInElsewhere).toHaveCount(0);

  const reopened = nextOpenSocket(first);
  await shop(first).reconnect.click();
  await reopened;
  await expect(shop(first).signedInElsewhere).toHaveCount(0);
  await expect(shop(second).signedInElsewhere).toBeVisible();
  await expect(shop(third).signedInElsewhere).toHaveCount(0);
  await context.close();
});
