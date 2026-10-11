import type { Page } from "playwright/test";
import { awaitHydration, expect } from "./fixtures.ts";

export const signIn = (page: Page) => ({
  email: page.getByLabel("Email"),
  send: page.getByRole("button", { name: "Send link" }),
  checkEmail: page.getByRole("heading", { name: "Check your email" }),
  openLink: page.getByRole("link", { name: "Open link" }),
});

export const shell = (page: Page) => ({
  signOut: page.getByRole("button", { name: "Sign out" }),
  members: page.getByRole("link", { name: "Members" }),
});

export const shop = (page: Page) => ({
  count: page.getByRole("status", { name: "Count" }),
  increment: page.getByRole("button", { name: "Increment" }),
  activation: page.getByText(/^Activation /),
});

/** Submits the sign-in form on a hydrated `/sign-in` and waits for the confirmation. */
export const requestMagicLink = async (page: Page, email: string) => {
  const screen = signIn(page);
  await screen.email.fill(email);
  await screen.send.click();
  await expect(screen.checkEmail).toBeVisible();
};

/** Follows a magic link: a full page load that ends wherever the verify redirect lands. */
export const followMagicLink = async (page: Page, link: string) => {
  await page.goto(link);
  await awaitHydration(page);
};
