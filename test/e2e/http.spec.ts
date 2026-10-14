import { expect, test } from "./fixtures.ts";

/**
 * The Website's HTTP behavior, through the `request` fixture alone: no page, so no browser. The
 * guards run in `beforeLoad` during SSR, so their redirects are plain HTTP redirects.
 */
test.use({ storageState: { cookies: [], origins: [] } });

test("a signed-out request to the member area redirects to sign-in", async ({ request }) => {
  const response = await request.get("/app", { maxRedirects: 0 });
  expect(response.headers().location).toBe("/sign-in?redirect=%2Fapp");
});

test("a signed-in member's request to the member area returns HTML", async ({
  request,
  signIn,
}) => {
  await signIn("m1@m.com");
  const response = await request.get("/app", { maxRedirects: 0 });
  expect(response.headers()["content-type"]).toContain("text/html");
});

test("a member's request to the admin area is sent to the member area", async ({
  request,
  signIn,
}) => {
  await signIn("m1@m.com");
  const response = await request.get("/admin", { maxRedirects: 0 });
  expect(response.headers().location).toBe("/app");
});

test("the auth proxy serves only verify and sign-out: get-session is not found", async ({
  request,
  signIn,
}) => {
  await signIn("m1@m.com");
  const response = await request.get("/api/auth/get-session");
  expect(response.status()).toBe(404);
});
