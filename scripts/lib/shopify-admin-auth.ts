import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

/** A failure of the cookie export; every message is for the person at the terminal. */
export class ShopifyAdminAuthError extends Schema.TaggedError<ShopifyAdminAuthError>()(
  "ShopifyAdminAuthError",
  { message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

/** The Shopify cookie hosts, as Chrome's `host_key` writes them: the session lives across them. */
const SHOPIFY_HOSTS = [".shopify.com", "admin.shopify.com", "accounts.shopify.com"] as const;

const SAME_SITE: Record<string, "Lax" | "None" | "Strict"> = {
  "-1": "Lax",
  "0": "None",
  "1": "Lax",
  "2": "Strict",
};

/** Seconds between the Windows epoch Chrome counts from (1601) and the Unix epoch. */
const CHROME_EPOCH_OFFSET_SECONDS = 11_644_473_600n;

/**
 * A Chrome profile directory name. It becomes a path segment, so a separator or a dot-only name
 * (which would leave the Chrome directory) is refused.
 */
export const ChromeProfile = Schema.String.check(
  Schema.isPattern(/^(?!\.+$)[^\\/]+$/u, {
    message: "Chrome profile must be a directory name such as Default or Profile 1.",
  }),
);

/**
 * The profile the Shopify admin session is read from. Chrome names its first profile `Default`; another
 * (`Profile 1`, shown at chrome://version as Profile Path) is passed with `--profile`.
 */
export const CHROME_PROFILE: typeof ChromeProfile.Type = "Default";

/**
 * How long an exported admin session is trusted before the setup re-reads Chrome.
 * `_merchant_essential` is issued with a one-year expiry and replaced on every admin load, so
 * its expiry says nothing about whether the session behind it is still accepted; its age does.
 * A day matches the lifetime the old `koa.sid` carried, the only figure Shopify has shown.
 */
export const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** A cookie as Playwright's storage state holds it. */
export interface StorageCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly sameSite: "Lax" | "None" | "Strict";
  /** Unix seconds, or -1 for a session cookie. */
  readonly expires: number;
}

/**
 * A local freshness check, not proof that Shopify accepts a session.
 *
 * Two cookies count, because Shopify changed which one carries the Shopify admin session. Until
 * September 2026 it was `koa.sid` on `admin.shopify.com`, a 24-hour cookie whose expiry was the
 * check (more than 5 minutes left). Since then an admin load sets no cookie on that host and
 * re-issues `_merchant_essential` on `.shopify.com` instead, judged by `issuedAt` (when Chrome
 * created it, or when the export was written) rather than by its expiry.
 *
 * @param now Epoch ms; a parameter so the edges are testable.
 */
export const adminSessionFresh = (
  cookies: ReadonlyArray<Pick<StorageCookie, "name" | "domain" | "expires">>,
  issuedAt: number,
  now: number = Date.now(),
) =>
  cookies.some(
    (cookie) =>
      (cookie.name === "koa.sid" &&
        cookie.domain === "admin.shopify.com" &&
        (cookie.expires === -1 || cookie.expires * 1000 > now + 5 * 60_000)) ||
      (cookie.name === "_merchant_essential" &&
        cookie.domain === ".shopify.com" &&
        issuedAt > now - SESSION_MAX_AGE_MS),
  );

/** Chrome's microseconds since 1601 as epoch milliseconds. */
export const chromeMicrosToEpochMs = (micros: bigint): number =>
  Number(micros / 1000n - CHROME_EPOCH_OFFSET_SECONDS * 1000n);

/** Chrome's microseconds since 1601 as Unix seconds. */
const chromeMicrosToEpochSeconds = (micros: bigint): number =>
  Number(micros / 1_000_000n - CHROME_EPOCH_OFFSET_SECONDS);

/** The key Chrome on macOS derives from the "Chrome Safe Storage" Keychain password. */
export const deriveKey = (password: string): Buffer =>
  pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");

/**
 * Decrypts a `v10` cookie value (AES-128-CBC, a fixed space-filled IV) and drops the 32-byte
 * hash Chrome prepends to the plaintext; anything not `v10` is plain text.
 */
export const makeDecrypt = (key: Buffer) => {
  const iv = Buffer.alloc(16, 0x20);
  return (encrypted: Uint8Array): string => {
    const buf = Buffer.from(encrypted);
    if (buf.length < 3 || buf.subarray(0, 3).toString() !== "v10") return buf.toString("utf8");
    const decipher = createDecipheriv("aes-128-cbc", key, iv);
    return Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()])
      .subarray(32)
      .toString("utf8");
  };
};

/**
 * Reads the "Chrome Safe Storage" password from the login keychain, which makes macOS ask the
 * person to allow it. stdin is closed so the lookup can never wait on input, and stderr is
 * dropped. Everything the lookup prints stays inside this effect, and every failure is a fixed
 * message: an error must never carry the password into a log. Interruption terminates the
 * process, escalating to SIGKILL.
 */
export const readSafeStoragePassword = Effect.fn("readSafeStoragePassword")(
  function* () {
    const handle = yield* ChildProcess.make(
      "/usr/bin/security",
      ["find-generic-password", "-w", "-s", "Chrome Safe Storage"],
      { stdin: "ignore", stderr: "ignore", forceKillAfter: "2 seconds" },
    );
    const [password, code] = yield* Effect.all(
      [Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode],
      { concurrency: "unbounded" },
    );
    if (code !== ChildProcessSpawner.ExitCode(0) || password.trim() === "")
      return yield* new ShopifyAdminAuthError({
        message:
          "Keychain access failed: unlock your login keychain and allow access to Chrome Safe Storage, then retry.",
      });
    return password.trim();
  },
  Effect.scoped,
  Effect.timeout("120 seconds"),
  Effect.catchTag("TimeoutError", () =>
    Effect.fail(
      new ShopifyAdminAuthError({
        message:
          "Keychain access timed out after 120 seconds. Respond to the Chrome Safe Storage prompt, then retry.",
      }),
    ),
  ),
  Effect.mapError((error) =>
    error instanceof ShopifyAdminAuthError
      ? error
      : new ShopifyAdminAuthError({
          message: "Could not run the Chrome Safe Storage Keychain lookup.",
        }),
  ),
);

/**
 * Copies the cookie database and its `-wal` into a private temporary directory, because Chrome
 * holds the original open and SQLite must not write beside it. Scoped: the copy is removed with
 * the scope.
 */
export const copyCookieDatabase = Effect.fn("copyCookieDatabase")(function* (cookiesPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const copyFailed = (what: string, source: string) => (cause: unknown) =>
    new ShopifyAdminAuthError({
      message: `Failed to copy Chrome cookie ${what}: ${source}`,
      cause,
    });
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-chrome-cookies-" });
  yield* fs.chmod(directory, 0o700);
  const copy = path.join(directory, "Cookies");
  yield* fs.copyFile(cookiesPath, copy).pipe(Effect.mapError(copyFailed("database", cookiesPath)));
  const wal = `${cookiesPath}-wal`;
  if (yield* fs.exists(wal).pipe(Effect.orElseSucceed(() => false)))
    yield* fs.copyFile(wal, `${copy}-wal`).pipe(Effect.mapError(copyFailed("WAL", wal)));
  return copy;
});

/** A row of Chrome's `cookies` table, read with bigints (`setReadBigInts`). */
const CookieRow = Schema.Struct({
  name: Schema.String,
  value: Schema.String,
  encrypted_value: Schema.Uint8Array,
  host_key: Schema.String,
  path: Schema.String,
  is_secure: Schema.BigInt,
  is_httponly: Schema.BigInt,
  samesite: Schema.BigInt,
  expires_utc: Schema.BigInt,
  has_expires: Schema.BigInt,
  creation_utc: Schema.BigInt,
});
const decodeRows = Schema.decodeUnknownSync(Schema.Array(CookieRow));

/**
 * The Shopify cookies in a copied database, decrypted, and `issuedAt`: when Chrome last created
 * `_merchant_essential`. The Shopify admin re-issues it on every load, so that is when the Shopify admin was
 * last open in Chrome.
 */
export const readShopifyCookies = Effect.fn("readShopifyCookies")(function* (
  dbPath: string,
  decrypt: (encrypted: Uint8Array) => string,
) {
  return yield* Effect.try({
    try: () => {
      const db = new DatabaseSync(dbPath);
      try {
        const statement = db.prepare(
          `select name, value, encrypted_value, host_key, path, is_secure, is_httponly, samesite, expires_utc, has_expires, creation_utc
             from cookies
             where host_key in (${SHOPIFY_HOSTS.map(() => "?").join(", ")})`,
        );
        statement.setReadBigInts(true);
        const rows = decodeRows(statement.all(...SHOPIFY_HOSTS));
        const issuedAt = rows
          .filter((row) => row.name === "_merchant_essential")
          .reduce((latest, row) => Math.max(latest, chromeMicrosToEpochMs(row.creation_utc)), 0);
        const cookies: ReadonlyArray<StorageCookie> = rows.map((row) => ({
          name: row.name,
          value: row.encrypted_value.length > 0 ? decrypt(row.encrypted_value) : row.value,
          domain: row.host_key,
          path: row.path,
          secure: row.is_secure === 1n,
          httpOnly: row.is_httponly === 1n,
          sameSite: SAME_SITE[row.samesite.toString()] ?? "Lax",
          expires: row.has_expires === 1n ? chromeMicrosToEpochSeconds(row.expires_utc) : -1,
        }));
        return { cookies, issuedAt };
      } finally {
        db.close();
      }
    },
    catch: (cause) =>
      new ShopifyAdminAuthError({ message: "Failed to read cookies from Chrome database", cause }),
  });
});

/**
 * Writes the storage state through a staging directory beside the output (0700), so the rename
 * replaces the state atomically: a failed write leaves the previous export intact, and the
 * scope removes only this call's staging directory. The file is 0600; it holds a login.
 *
 * Refuses a session that is not fresh. The check reads Chrome's cookie database on disk, not the
 * cookies Chrome holds in memory, and a Chrome that has run for days can stop writing that file
 * while the Shopify admin keeps working, so the check fails with the Shopify admin open. Quitting Chrome (Cmd-Q,
 * not closing the window) writes the cookies out.
 */
export const writeStorageState = Effect.fn("writeStorageState")(function* (
  output: string,
  cookies: ReadonlyArray<StorageCookie>,
  issuedAt: number,
) {
  if (!adminSessionFresh(cookies, issuedAt))
    return yield* new ShopifyAdminAuthError({
      message:
        "Chrome's Shopify admin session is expired or missing. Open the store's admin at https://admin.shopify.com in a normal window of the selected Chrome profile, wait for the dashboard to load, then retry. If the admin is already open, Chrome may not have written its cookies to disk: quit Chrome with Cmd-Q, reopen it, load the admin, then retry. The previous export was kept.",
    });
  const fs = yield* FileSystem.FileSystem;
  const parent = path.dirname(output);
  yield* fs.makeDirectory(parent, { recursive: true, mode: 0o700 });
  const directory = yield* fs.makeTempDirectoryScoped({
    directory: parent,
    prefix: ".shopify-auth-",
  });
  yield* fs.chmod(directory, 0o700);
  const staged = path.join(directory, "state.json");
  yield* fs.writeFileString(staged, JSON.stringify({ cookies, origins: [] }, null, 2), {
    mode: 0o600,
    flag: "wx",
  });
  yield* fs.rename(staged, output);
}, Effect.scoped);

/**
 * Exports the Shopify cookies of a Chrome profile into a Playwright storage state and answers
 * how many it found. macOS only. `dryRun` reads and decrypts without writing, and still asks
 * for the Keychain. The 150 s deadline holds the 120 s Keychain bound.
 */
export const exportShopifyAdminAuth = Effect.fn("exportShopifyAdminAuth")(
  function* ({
    output,
    profile,
    dryRun = false,
  }: {
    readonly output: string;
    readonly profile: typeof ChromeProfile.Type;
    readonly dryRun?: boolean;
  }) {
    if (process.platform !== "darwin")
      return yield* new ShopifyAdminAuthError({
        message: `Unsupported platform: ${process.platform} (macOS only)`,
      });
    const cookiesPath = path.join(
      homedir(),
      "Library/Application Support/Google/Chrome",
      profile,
      "Cookies",
    );
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(cookiesPath)))
      return yield* new ShopifyAdminAuthError({
        message: `Chrome cookie database not found for profile ${profile}: ${cookiesPath}`,
      });
    const decrypt = makeDecrypt(deriveKey(yield* readSafeStoragePassword()));
    const { cookies, issuedAt } = yield* readShopifyCookies(
      yield* copyCookieDatabase(cookiesPath),
      decrypt,
    );
    if (!dryRun) yield* writeStorageState(output, cookies, issuedAt);
    return cookies.length;
  },
  Effect.scoped,
  Effect.timeout("150 seconds"),
  Effect.catchTag("TimeoutError", () =>
    Effect.fail(
      new ShopifyAdminAuthError({
        message:
          "Shopify auth refresh timed out after 150 seconds; retry after checking Chrome and Keychain access.",
      }),
    ),
  ),
);
