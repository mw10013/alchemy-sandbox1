import * as Schema from "effect/Schema";
import { E2eEmail } from "../src/api/test-control.ts";
import { control, expect, test } from "./fixtures.ts";

test.use({ storageState: "playwright/.auth/admin.json" });

test("the admin sees the seed members", async ({ goto, page }) => {
  await goto("/admin/members");
  await expect(page.getByRole("table")).toMatchAriaSnapshot(`
    - table:
      - rowgroup:
        - row:
          - columnheader "Email"
          - columnheader "Role"
          - columnheader "Added"
      - rowgroup:
        - row:
          - cell "a@a.com"
          - cell "admin"
          - cell /\\d{4}-\\d{2}-\\d{2}/
        - row:
          - cell "m1@m.com"
          - cell "user"
          - cell /\\d{4}-\\d{2}-\\d{2}/
        - row:
          - cell "m2@m.com"
          - cell "user"
          - cell /\\d{4}-\\d{2}-\\d{2}/
  `);
});

test("a member created through test control is listed", async ({ backend, goto, page }) => {
  const email = Schema.decodeUnknownSync(E2eEmail)(`e2e-${test.info().testId}@e2e.test`);
  await backend(control((c) => c.CreateMember({ email, role: "user" })));
  await goto("/admin/members");
  await expect(page.getByRole("cell", { name: email })).toBeVisible();
});
