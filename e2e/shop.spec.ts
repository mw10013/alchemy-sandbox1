import * as Schema from "effect/Schema";
import { EmailFromInput } from "../src/api/backend.ts";
import { SANDBOX_SHOP } from "../src/api/shop.ts";
import {
  awaitHydration,
  control,
  expect,
  merchant,
  nextBoundSocket,
  ownMember,
  test,
} from "./fixtures.ts";
import type { Page } from "playwright/test";
import { followMagicLink, shell, shop } from "./screens.ts";

test.use({ storageState: "playwright/.auth/member.json" });

/** Every test here reads or writes the one shop's count, so they take turns. */
test.describe.configure({ mode: "serial" });

const path = `/app/shop/${SANDBOX_SHOP}`;

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

test("the merchant resets the count and a member sees it", async ({
  backend,
  browser,
  goto,
  page,
}) => {
  await goto(path);
  await shop(page).increment.click();
  await expect(shop(page).count).not.toHaveText("0");

  const merchantContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const merchantPage = await merchantContext.newPage();
  await merchant(merchantPage, backend, SANDBOX_SHOP);
  await expect(shop(merchantPage).merchantOf(SANDBOX_SHOP)).toBeVisible();
  await expect(shop(merchantPage).increment).toHaveCount(0);
  await shop(merchantPage).reset.click();

  await expect(shop(merchantPage).count).toHaveText("0");
  await expect(shop(page).count).toHaveText("0");
  await merchantContext.close();
});

test("sign-out in one window sends the other to sign-in; an admin is untouched", async ({
  backend,
  browser,
}) => {
  const { context, page } = await ownMember(browser, backend, `signout-${test.info().workerIndex}`);
  await page.goto(path);
  await awaitHydration(page);
  const other = await context.newPage();
  const bound = nextBoundSocket(other);
  await other.goto(path);
  await awaitHydration(other);
  await bound;

  const adminContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const admin = await adminContext.newPage();
  const { link } = await backend(
    control((c) =>
      c.IssueMagicLink({ email: Schema.decodeUnknownSync(EmailFromInput)("a@a.com") }),
    ),
  );
  await followMagicLink(admin, link);
  await admin.waitForURL(/\/admin$/);

  await shell(page).signOut.click();

  await other.waitForURL(/\/sign-in/);
  await expect(admin).toHaveURL(/\/admin$/);
  await expect(shell(admin).signOut).toBeVisible();
  await adminContext.close();
  await context.close();
});

test("a member removed while the page is open is told so", async ({ backend, browser }) => {
  const { email, context, page } = await ownMember(
    browser,
    backend,
    `removed-${test.info().workerIndex}`,
  );
  const bound = nextBoundSocket(page);
  await page.goto(path);
  await awaitHydration(page);
  await bound;

  await backend(control((c) => c.RemoveMember({ shop: SANDBOX_SHOP, email })));

  await expect(shop(page).notAMember).toBeVisible();
  await context.close();
});

test("a third window displaces the oldest, and Reconnect there takes it back", async ({
  backend,
  browser,
}) => {
  const { context, page: first } = await ownMember(
    browser,
    backend,
    `displaced-${test.info().workerIndex}`,
  );
  const open = async (page: Page) => {
    const bound = nextBoundSocket(page);
    await page.goto(path);
    await awaitHydration(page);
    await bound;
    return page;
  };
  await open(first);
  const second = await open(await context.newPage());
  const third = await open(await context.newPage());

  await expect(shop(first).signedInElsewhere).toBeVisible();
  await expect(shop(second).signedInElsewhere).toHaveCount(0);

  const rebound = nextBoundSocket(first);
  await shop(first).reconnect.click();
  await rebound;
  await expect(shop(first).signedInElsewhere).toHaveCount(0);
  await expect(shop(second).signedInElsewhere).toBeVisible();
  await expect(shop(third).signedInElsewhere).toHaveCount(0);
  await context.close();
});
