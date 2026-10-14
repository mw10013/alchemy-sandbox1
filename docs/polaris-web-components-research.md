# Research: replacing Astryx with Polaris web components 2.0 RC

Research date: 2026-10-13. Status: decisions accepted 2026-10-13 (§8); implemented 2026-10-13, uncommitted (§10).
Background: [Glossary](./glossary.md). The model project is `refs/baton`, which uses Polaris web components 1.x across a public site, a member area, an operator admin and an embedded Shopify app.

## 1. Summary

- **Yes, Polaris web components 2.0 RC work in the Website today, with no App Bridge.** The 2.0 RC is a CDN script, `https://cdn.shopify.com/shopifycloud/polaris-2.0-rc.js`. It needs no API key and no App Bridge. With no App Bridge present, it renders the new "Admin Next" look by default (§3.2). Baton already runs Polaris 1.x on pages that never load App Bridge: `/`, `/help`, `/login`, `/shop/*` and `/admin/*`.
- **Types:** `@shopify/polaris-types@2.0.0-rc.3` (npm dist-tag `next`; `latest` is still 1.1.0), pinned exactly as a dev dependency.
- **Layout:** Polaris has no sidebar or app shell outside the Shopify admin. Baton's answer, which we would copy:
  - a thin top bar;
  - `s-page` with `inlineSize`;
  - `s-section` cards;
  - breadcrumbs and back links in place of a side menu.

  The current `AdminShell`/`MemberShell` sidebars go away (§5).

- **Refs:** add a CDN-snapshot ref kind to `scripts/refs.ts`. It downloads `polaris-2.0-rc.js`, formats it with `vp fmt` (about 920 KB on one line becomes about 32k lines, in about 2 s), and stamps it with the build hash from the bundle's first line. Also add the types package (`polaris.d.ts` plus `custom-elements.json`) and the `v2.0-rc` doc pages, which the Shopify docs mirror misses today (§7). The formatted bundle already proved its worth here: it is how §3.2 and §3.4 were found.
- **Biggest trade-offs:**
  - We lose dark mode (§3.4).
  - We lose layout freedom on purpose; Polaris is narrower than Astryx's 166 components.
  - Browser tests and e2e start depending on a CDN script (§6).

## 2. What Polaris 2.0 RC is

The source is `refs/shopify-docs/docs/apps/build/app-home/polaris2.md` ("Update your app for Polaris 2"). The live `v2.0-rc` reference is at `https://shopify.dev/docs/api/app-home/v2.0-rc/web-components`.

- The Shopify admin is getting "a new frame, new navigation, and a new visual appearance". The 2.0 RC updates the web components "so that your app matches the look and feel of this new Shopify admin experience".
- The change is mostly visual, as expected:
  - The 2.0 RC bundle defines the same 64 public `s-*` elements as `polaris-1.1.js`. A diff of the element names found in both bundles is empty.
  - Diffing the `latest` (v1.1) and `v2.0-rc` doc pages for `s-page` shows only the version and link URLs changing.
- Caution, quoted from the docs: "Release candidates can change during the soak period … switch over when the release candidate is promoted to a stable version."
- Channels, from the `v2.0-rc` versioning page:

  | URL                                | Serves                                                     |
  | ---------------------------------- | ---------------------------------------------------------- |
  | `polaris.js` (unversioned, legacy) | Tracks 1.x and "never serves 2.x". Baton uses this one.    |
  | `polaris-1.js`                     | Newest stable 1.x                                          |
  | `polaris-1.1.js`                   | 1.1. Byte-identical to `polaris.js` today.                 |
  | `polaris-2.0-rc.js`                | The 2.0 release candidate. There is no `polaris-2.js` yet. |

- When the RC is promoted, Shopify publishes the stable release at its own new URL; it does not update the RC URL in place. The v1.1 versioning page says so: "Promotion doesn't update the release candidate URL in place." Moving to stable 2.x is therefore a deliberate change to the script URL and the types package together.
- Every channel sends `cache-control: max-age=60, stale-while-revalidate=300`, and none sends a version header. The only version marker is the build hash comment on the first line:
  - 2.0 RC: `/*!6e07695b…*/`
  - 1.1: `/*!f4125fdd…*/`
- Size of `polaris-2.0-rc.js`, measured 2026-10-13:

  | Encoding | Size   |
  | -------- | ------ |
  | raw      | 920 KB |
  | gzip     | 195 KB |
  | brotli   | 175 KB |

  It sends `access-control-allow-origin: *`. The bundle includes its own Preact runtime.

- Types are matched to the bundle by hand. From the docs: "If you load `polaris-2.0-rc.js`, then install `@shopify/polaris-types@^2.0.0-rc.0` … update the script tag and the package together". We pin exactly instead of using `^`, per our pinned-version rule.

## 3. Using it outside the Shopify admin

### 3.1 What needs App Bridge

- **The plain `s-*` components do not need App Bridge.** The docs' "Other frameworks" snippet shows a `shopify-api-key` meta tag next to the script, but that tag is for App Bridge. Baton's public, member and admin pages load `polaris.js` with no meta tag and no `app-bridge.js`, and they work in production.
- **What does need App Bridge**, and so is out of scope until the embedded app exists:
  - `s-app-nav`
  - `ui-title-bar`
  - `ui-save-bar`
  - `s-app-window`
  - `ui-modal`
  - `shopify.*` APIs such as toast, `shopify.modal` and `shopify.idToken`

  These are all App Bridge web components and APIs, documented under `app-bridge-web-components`. `s-modal` itself is Polaris and works standalone; baton opens it with `commandFor`/`command="--show"`.

- **`s-page` slots and props.**
  - These work standalone: `heading`, `inlineSize`, `breadcrumb-actions`, `primary-action`, `secondary-actions`, `supplemental-start`, `aside`.
  - Inside the admin, the page header is lifted into the admin's title bar. Standalone, it renders inline.

### 3.2 Which look renders without App Bridge

The docs say the 2.0 bundle "carries both the current admin theme and Admin Next, and follows whichever theme the merchant's admin is using", and that "the Shopify admin signals which styling to use through App Bridge". They do not say what happens with no admin at all.

The formatted bundle answers it. The theme module reads a global `__shopifyAdminTheme`:

- If the global is set before Polaris initializes, Polaris uses it: `"admin-next"` gives Admin Next, any other value gives `"admin"`.
- If the global is not set, Polaris defines a setter for later and **defaults to `"admin-next"`**, adding the class `p-partial-theme-admin-next` to `<html>`.

So a standalone page on the 2.0 RC gets the new look. You could force the old look by setting `globalThis.__shopifyAdminTheme = "admin"` before the script runs, but that is undocumented and not needed.

### 3.3 Fonts and network

- The 2.0 bundle loads its fonts from `cdn.shopify.com/static/fonts/shopifyinter/v0/styles.css` and `.../inter/v4/styles.css`, along with icons and assets from `cdn.shopify.com/shopifycloud/admin-ui-foundations/`. Every page therefore depends on `cdn.shopify.com`.
- No CSP is set today (the survey found no `Content-Security-Policy` anywhere). If one is added later, it must allow that origin for scripts, styles and fonts.

### 3.4 Dark mode

- The bundle's CSS contains a `p-partial-theme-admin-next-dark` palette.
- The bundle's JS never applies that class (it appears once in the bundle, inside the CSS string), and the docs mention no dark mode.
- Today the Website renders Astryx with `mode="dark"`. The move makes the site light-only. Applying the dark class by hand would rely on an undocumented internal.

### 3.5 Terms of use

- **No permission, no prohibition.** The mirror has no licence or terms text for the Polaris CDN bundle. It also never says the bundle may be used only inside the admin.
- **Wording that supports standalone use:**
  - `api/app-home/latest.md`: "Polaris components are built on the Web Components standard … Use them in any framework or with vanilla JavaScript."
  - `apps/build/app-home.md` says much the same.
- **Wording that points the other way:**
  - Every documented setup is App Home, inside the admin iframe.
  - The migration guide suggests that public, authentication and standalone routes _keep_ Polaris React (`migrate-from-polaris-react.md`: "If a public, authentication, or standalone route still requires Polaris React, then keep the dependency…").
  - Read together, Shopify does not promise anything for non-embedded pages.
- **Baton already runs this way,** on its public, member and admin pages. The practical risk is that Shopify changes something for non-embedded pages without notice, not that the use is forbidden. The App Bridge `auto-redirect` behaviour (it redirects into the admin when loaded outside it) only applies if `app-bridge.js` is loaded, which non-embedded routes never do.

## 4. Wiring it into TanStack Start

Follow baton (`refs/baton/src/routes/__root.tsx`, `src/lib/shopifyConstants.ts`, `tsconfig.json`):

- **Script in `<head>`, not body-end.**
  - Put `<script src={POLARIS_URL} />` right after `<HeadContent />`, with the URL in one constant.
  - Why the head, per baton (checked 2026-09-22): loaded at body-end, elements upgrade in define order. `s-table-row` then upgrades before `s-table`, and server-rendered rows break.
  - Why after `<HeadContent />`: route-level scripts such as a future `app-bridge.js` stay first. The App Store requires App Bridge to be the first script.
- **Inert until hydrated.**
  - Baton renders `<body inert={!hydrated}>`. That blocks input on server-rendered custom elements until React has attached handlers, so no control needs its own `disabled` guard.
  - We already set `data-hydrated` on `<body>` and e2e waits on it (`e2e/fixtures.ts`). Adding `inert` is a one-attribute change.
- **Types.**
  - Run `vp add -D -E @shopify/polaris-types@2.0.0-rc.3`; `saveExact: true` is already set in `pnpm-workspace.yaml`.
  - Add `"@shopify/polaris-types"` to `compilerOptions.types`.
  - The package augments `react`'s `JSX.IntrinsicElements` for every `s-*` tag, so no wrappers are needed.
  - `polaris.d.ts` imports from `preact` without declaring it as a dependency. Baton has no `preact` installed and relies on `skipLibCheck: true`, which we also set. Verify after the install that `s-*` props are still typed rather than `any`; the fallback is a `preact` dev dependency used only for types.
- **React 19 is required.** The migration guide says "React 18 doesn't provide the custom-element property and event behavior that controlled Polaris web components rely on." We are on 19.3.0.
- **Events and forms, as baton writes them:**
  - The docs' rules: camelCase JSX props (`accessibilityLabel`, `commandFor`), `href` rather than `url`, and values read from `event.currentTarget.value` or `.checked`. Fields are form-associated, so they take part in `FormData`. There is no `s-form` and no `s-card`; `s-section` plays the role of a card.
  - Handlers go directly on the elements: `s-button onClick`, `onInput={(e) => field.handleChange(e.currentTarget.value)}` on text and email fields, and `onChange` on selects and checkboxes.
  - Forms are a native `<form onSubmit>` around TanStack Form fields, with `error={…}` on the field element and `<s-button type="submit" variant="primary">`.
  - Loading is spread in as `{...(pending ? { loading: true } : {})}`.
  - `rel` is missing from `s-link`'s type, so baton spreads it: `{...{ rel: "home" }}`.
- **Links.** Outside the embedded app, nothing intercepts `s-link` or `s-button href` clicks, so they do full document loads. For client-side navigation, use a TanStack `<Link>` (in baton's top bar), or `s-button` with `href` plus an `onClick` that calls `preventDefault()` and `navigate()` (baton's `BackLink`).

## 5. Layout: how baton does it with no sidebar

Shopify publishes page templates under `refs/shopify-docs/docs/api/app-home/latest/patterns/` (`homepage`, `resource-index`, `details`, `settings`) plus compositions (`footer-help`, `setup-guide`, `index-table`, …). These are the closest thing to Astryx's `astryx template`.

Polaris's page frame is `s-page` with `inlineSize` set to `small` (about 630 px), `base` or `large`, containing `s-section` cards. Navigation comes from the admin (`s-app-nav`). Outside the admin there is no navigation component, so baton built these patterns:

| Area                           | Baton route               | Pattern                                                                                                                                                                                                                                                                                                    |
| ------------------------------ | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public landing, sign-in, legal | `/`, `/login`, `/privacy` | One `s-page inlineSize="small"` with `s-section`s. No bar.                                                                                                                                                                                                                                                 |
| Public help                    | `/help/*`                 | `s-page` with `s-link slot="breadcrumb-actions"` crumbs (Baton › Help › Section). Hub pages have an "In this section" list. Each page ends with a sibling-page list. `refs/baton/docs/help-research.md` records why: "`s-page` has no sidebar".                                                            |
| Member area                    | `/shop/*`                 | `<MemberBar>`, a top bar with the home mark and shop on the left and Help, email and Sign out on the right, above `s-page inlineSize="small"`. Detail pages add a `BackLink` (tertiary `s-button icon="arrow-left"`) between the bar and the page, not breadcrumbs, because those fold into "…" on phones. |
| Operator admin                 | `/admin/*`                | Plain `s-page`, a Sign out `s-button slot="secondary-actions"`, and sections whose buttons navigate.                                                                                                                                                                                                       |
| Embedded app                   | `/app/*`                  | `s-app-nav` (App Bridge) and `s-page inlineSize="large"`. Not applicable yet.                                                                                                                                                                                                                              |

### Layout discipline

- Baton forbids `s-grid`, `s-stack`, `s-box`, `s-query-container` and every spacing or layout prop in routes, enforced by `scripts/lib/rules-lint.ts`.
- Layout lives only in named parts under `src/components/screen/` (`Things`, `Inline`, `Tiles`, `Strip`, `ResourceRow`, `PageBody`, …).
- Spacing is limited to three values: `small-300`, `base` and `none`.
- One container-query breakpoint (480 px) drives side-by-side layouts.
- `src/lib/Screen.ts` is the spec.
- About 290 lines of `styles.css` cover what Polaris lacks, such as the member bar and print rules. This is the part to port as baton pieces come over.

### What changes in this Website

| Route                      | Today (Astryx)                                               | Polaris version                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                        | `AppShell` with `TopNav`, a hero, and the `Playground` cards | `s-page inlineSize="small"`. Sign in, or Dashboard plus Sign out, as `secondary-actions`. Playground as two `s-section`s.                                                                          |
| `/sign-in`                 | `Center`, `Card` and a form                                  | `s-page inlineSize="small"` and an `s-section` holding the form, as in baton's `/login`                                                                                                            |
| `/admin`, `/admin/members` | `SideNavShell` (Home, Members, Sign out) and a `Table`       | No bar (decision 3): plain `s-page`s with a `secondary-actions` Sign out. Admin home has a section linking to Members. Members is an `s-section` holding an `s-table`, with an "Admin" breadcrumb. |
| `/app`, `/app/shop/$key`   | `SideNavShell` (Home, Shop, Sign out) and `Card`             | Top bar and `s-page`. Shop page: `s-banner`s and an `s-section` with count and buttons.                                                                                                            |
| `/merchant/$key`           | `ShopPage` with no shell                                     | `s-page`, same body as above                                                                                                                                                                       |
| not found                  | `AppShell` and `Heading`                                     | `s-page heading="Page not found"`                                                                                                                                                                  |

## 6. What removing Astryx touches

- **Code.**
  - Ten files under `src/` and `test/browser/render.tsx` import Astryx.
  - Delete `SideNavShell`, `RouterLink`/`LinkProvider` and `Theme`, and reduce `src/styles.css` to our own rules.
  - `RouterLink`/`LinkProvider` exist only to adapt Astryx links to TanStack Router.
- **Dependencies.**
  - Remove `@astryxdesign/core`, `@astryxdesign/theme-neutral`, `@astryxdesign/cli` and `@stylexjs/stylex`, which nothing imports directly.
  - Remove the `astryx` script, the `astryx` field in `package.json`, and the two `allowBuilds` entries.
  - Remove the `astryx` ref in `scripts/refs.ts`.
- **Docs.**
  - The `<!-- ASTRYX:START -->…<!-- ASTRYX:END -->` block in AGENTS.md is generated by the Astryx CLI. Delete it and replace it with a short Polaris rules block.
  - Rewrite the README's Astryx sections, plus the `@see refs/astryx/...` template credits in the page JSDoc.
- **Tests.**
  - `test-setup.test.tsx` asserts that Astryx's Figtree font loaded. It becomes a check that Polaris loaded, e.g. `customElements.get("s-button")` is defined and a rendered `s-button` has a shadow root.
  - Vitest browser mode needs the Polaris script on its test page, via a `<script>` added in setup. That creates a CDN dependency in unit-ish tests.
  - Role and label selectors mostly survive. Polaris renders real controls in open shadow roots, and Playwright and Vitest browser locators pierce them; baton's e2e uses `getByRole("textbox"|"button"|"combobox"|"link", { name })` throughout.
  - Selectors to re-check:
    - `shell.signOut`, which expects a `button`;
    - `shell.members`, which expects a `link`;
    - `members.spec.ts`, which expects `table`, `columnheader`, `row` and `cell` roles, to be confirmed against `s-table`;
    - `getByRole("status", { name: "Count" })`, which relies on `aria-labelledby` on Astryx `Text`. Polaris text elements may not forward that, so a plain `<output>` or a wrapper element might be needed.
  - The SSR test that string-matches `>7<` will see the count inside custom-element markup. Check that it still matches.

## 7. Reference material in `refs/`

`refs/` is gitignored and per machine, so snapshots belong there, not in `docs/`. Baton's `docs/polaris-app-bridge-cdn-research.md` §5–7 weighed the same idea: it found the JS bundles' value was "mostly behavior edge cases", and planned a "prettify post-pass" if one was ever wanted. §3.2 and §3.4 above are such edge cases, answered only by the bundle.

Proposed additions to `scripts/refs.ts`:

1. **`polaris` (new `Cdn` ref kind).**
   - Download `polaris-2.0-rc.js` and write both:
     - `refs/polaris/polaris-2.0-rc.min.js`, raw;
     - `refs/polaris/polaris-2.0-rc.js`, formatted with `vp fmt --stdin-filepath=polaris.js`, which takes about 2 s and gives about 32k lines.
   - Keep the raw file so the formatted copy can be regenerated, or diffed by hash.
   - Stamp `.ref.json` with the URL as `resolved`, the leading `/*!<hash>*/` build hash as `version`, and `fetchedAt`.
   - `refs check` can then report "build `6e07695b`, fetched …". It could compare against a HEAD request's `last-modified`, but every channel's `last-modified` moves daily even when the bytes do not, so the hash is the honest signal.
   - It is a 1 MB fetch, so it is not opt-in, and `--all` includes it.
   - The URL comes from the same constant the app uses, so the ref follows the channel the site loads.
2. **`polaris-types` (`Dependency`, npm tarball).**
   - `polaris.d.ts` (9.3k lines) and `custom-elements.json` (12.7k lines, the standard manifest with every attribute, event and slot), pinned to `devDependencies.@shopify/polaris-types`.
   - `node_modules/@shopify/polaris-types` already has these files, so this is optional. A ref is only worth it for a stable grep path that agents are told about.
3. **Shopify docs mirror gains `v2.0-rc`.**
   - `refs/shopify-docs` has only `docs/api/app-home/latest` (v1.1, 97 pages). The `v2.0-rc` pages exist (`…/v2.0-rc/web-components.md` returns 200) but are not in `sitemap_standard.xml.gz`, so the sitemap crawl never finds them.
   - Derive them by rewriting each discovered `app-home/latest/` URL to `app-home/v2.0-rc/`, and skip any 404s.
   - The `polaris2.md` guide is already mirrored.

App Bridge (`app-bridge.js`, `app-bridge.d.ts`) belongs to the later embedded-app work and is left out here.

## 8. Decisions

These were accepted in review on 2026-10-13. Each one is the recommendation the review was offered.

1. **Polaris version.** Load `polaris-2.0-rc.js` and pin `@shopify/polaris-types@2.0.0-rc.3` exactly. Move both to stable 2.x together when it ships.
2. **Dark mode.** The site goes light-only. Polaris's internal dark class will not be used.
3. **Navigation.** `/app` gets a top bar like baton's `MemberBar`. `/admin` uses baton's no-bar operator style: the home page lists the sections, and sub-pages use `breadcrumb-actions` and a `secondary-actions` Sign out.
4. **Layout discipline.** Write it into AGENTS.md now: layout parts live under `src/components/screen/`, and routes use no `s-stack`, `s-grid` or spacing props. Add the lint rule when baton pieces arrive.
5. **Refs.** Add a new `Cdn` ref kind that saves `polaris-2.0-rc.js` raw and formatted with `vp fmt`, stamped with the bundle's build hash. Add the `v2.0-rc` pages to the Shopify docs mirror. Types are read from `node_modules`; there is no `polaris-types` ref.
6. **Tests.** Browser-test setup loads the same Polaris CDN URL the site uses, so `vp test` needs network access.
7. **Rollout.** One change swaps all six screens, removes Astryx, and updates the tests and AGENTS.md.

## 9. Proposed steps

1. Install the types and add them to `tsconfig` `types`. Add the Polaris URL constant and the head script. Add `inert` to the body.
2. Rebuild the screens per §5, porting baton's top bar, `BackLink` and form pattern.
3. Update the tests per §6. Remove Astryx dependencies, config and docs.
4. Replace the AGENTS.md Astryx block with Polaris rules: the CDN script, `s-*` only, and where layout may live.
5. Add the `polaris` CDN ref and the `v2.0-rc` docs pages per §7.
6. Run `vp check --fix`, `vp test` and `vp run test:e2e`.

## 10. Deviations and issues

The implementer records here every departure from §4–9 and every problem found. Each entry says what happened, why, what was done instead, and whether it is still open. Review then adds a recommendation under each entry.

1. **Status line corrected.** The header said "not implemented"; it now says implemented and uncommitted. No other section was edited; corrections to earlier sections are recorded below instead. Closed.

2. **Types are real, no `preact` needed (§4).** After `vp add -D -E @shopify/polaris-types@2.0.0-rc.3` and adding it to `compilerOptions.types`, a probe file got real errors: `variant="nonsense"` on `s-button` was rejected with the `"auto" | "primary" | "secondary" | "tertiary"` union, and an unknown `s-not-a-real-element` tag was rejected. `polaris.d.ts` declares `declare module 'preact'` augmentations itself, so the `preact` import resolves to an ambient module even though `preact` is not installed. The `preact` dev-dependency fallback was not needed. Event props are typed loosely, though: `onClick` is `(event: Event) => void` while React hands a synthetic mouse event, so `useNavigateOnClick` reads modifier keys by name rather than with `instanceof MouseEvent`. Closed.

   **Review:** Accept.

3. **`s-table` exposes the ARIA grid pattern, not `table` (§6).** In the bundle, `s-table` renders `role="grid"` with `row`, `columnheader` and `gridcell`; there is no `table` or `cell` role. These roles sit on elements inside the shadow root, and the headers and cells are slotted in. As a result:
   - `getByRole("grid").getByRole("columnheader")` finds nothing, because a chained locator searches DOM descendants and slotted content is not one of them.
   - `toHaveText` reads DOM text, which excludes slotted content, so it returns `""` for each header.
   - Under Admin Next a row is `display: contents` (`.table-row:where(.admin-next)`), so Playwright reports a matching row as hidden.

   What changed in `e2e/members.spec.ts`: `table` became `grid` and `cell` became `gridcell`, locators start at the page, headers are checked in order with `toHaveAccessibleName` (accessible names do follow slots), rows are matched by an accessible-name regex that includes the date, and rows are asserted with `toHaveCount(1)` instead of `toBeVisible()`. The `columnheader` role, the header names and their order are still asserted. Open: the spec asked to keep the `table` role, which Polaris cannot give; review should accept `grid`.

   **Review:** Accept `grid`. It is what `s-table` actually exposes, and the spec still asserts header names and order. Keep the members spec's comment explaining why it is `grid`, for the next person.

4. **Critical banner text goes in `heading`, not in the content (§6).** `s-banner tone="critical"` puts `role="alert"` on a `div` inside its shadow root (warning, info and success get `role="status"`), and the banner's children are slotted. The alert element's `textContent` therefore does not include the message, and `getByRole("alert").toHaveTextContent(…)` failed for all three refusal tests in `ShopPage.test.tsx`. Under Admin Next the banner renders its `heading` inside that alert element. Every single-sentence banner (the shop refusals, the Shout failure, both sign-in errors, "Signed in elsewhere", "Reconnecting…") now passes the sentence as `heading` and has no body. Baton puts banner text in the body. The tests were not changed. Closed. Review may prefer body text with tests that assert `getByText` instead.

   **Review:** Accept. A one-sentence banner as `heading` puts the sentence inside the alert or status element that screen readers announce, so it is better than body text here. Use body text only when a banner has a title _and_ detail.

5. **The count is a native `<output>`, and so are the Playground results (§6).** Polaris text elements take no `role` and no `aria-labelledby` (their typed props are only `accessibilityVisibility`, `tone`, `color`, `type`, `fontSize`, `fontWeight` and similar). The count is now `<output aria-labelledby={countLabel}><s-heading fontSize="large-400">7</s-heading></output>`, with the label in an `s-text id`. `getByRole("status", { name: "Count" })` passes in both browser tests and e2e. The "Loading…" placeholder and the Playground's loader line and Shout result are also `<output>`, keeping their old `status` role. The SSR test's `>7<` still matches. Closed.

   **Review:** Accept.

6. **The `small` column is 784 px under Admin Next, not 630 px (§4, §5).** Measured with Playwright: `s-page inlineSize="small"` has a 49rem (784px) column with a 2rem gutter on narrow viewports. Baton's `.member-back` CSS assumes Polaris 1.x's 630px column and 1rem gutter, so a straight port put the back arrow about 75px inside the column. `.back-link` in `src/styles.css` now uses `max(2rem, (100% - 49rem) / 2)`. `s-page` exposes no custom property for the column, so this is a measured constant, and it will drift if Polaris changes it. Open: recheck when the RC changes or goes stable.

   **Review:** Accept. Keep the open item: recheck the 49rem column when the RC changes or 2.x goes stable.

7. **The Admin Next page header pins actions to the viewport (Polaris quirk).** Outside the admin, `s-page`'s `secondary-actions` (Sign in, Dashboard, Sign out) and its `breadcrumb-actions` render at the top corners of the viewport, not on the heading's line inside the column (see the `/`, `/admin` and `/admin/members` screens). `s-page` also renders its heading twice: once in that header strip and once above the content, which shows as two `heading "Members" [level=1]` entries in the accessibility snapshot. Both work and both pass the tests. Accepted as Polaris's standalone look. Open for review: is the detached Sign out on `/admin` acceptable?

   **Review:** Accept. Review confirmed it by forcing the old look (`__shopifyAdminTheme = "admin"`): with the old look, the same page draws Sign in inline beside the heading. Under Admin Next, `s-page` puts actions at the top right, where the new admin frame's header sits. So this is Polaris's intended Admin Next layout, not a bug. Don't force the old look. On `/` the accessibility tree has only one `h1`, so the duplicate heading appears only on breadcrumb pages; it is minor and caused by Polaris.

8. **Hydration warning on `<html>` (Polaris quirk).** Polaris adds `p-partial-theme-admin-next` to `<html>` while it loads, before React hydrates, and React logged a hydration mismatch on every page. `<html>` now has `suppressHydrationWarning`, as baton's does, with a comment. That suppresses attribute mismatches on that one element only. With it, the dev run had no console errors except the intended 404 on `/nope`. Closed.

   **Review:** Accept. Baton does the same.

9. **The admin layout differs from the §5 table, following decision 3.** The §5 "What changes" table says `/admin` gets a top bar like `MemberBar`, but decision 3 says no bar. I implemented decision 3: `/admin` and `/admin/members` are plain `s-page`s, each with a `secondary-actions` Sign out, the home page has a "Members" section whose `s-link` is named "Members" (so `shell.members` still resolves), and Members has an "Admin" breadcrumb. The home page also keeps "Signed in as …", as before. Closed.

   **Review:** Accept. The §5 table contradicted decision 3; review has corrected the table.

10. **Details of the screen rebuild.**
    - Parts: `src/components/screen/` holds `layout.ts` (two distances, `small-300` and `base`; baton's `none` and its breakpoint were not needed), `Things`, `Lines`, `Inline`, `IndexSection` (an `s-section padding="none"` around the table), `TopBar` and `BackLink`. Routes and other components use no `s-stack`, `s-grid`, `s-box` or spacing prop. Not enforced by lint, per decision 4.
    - New outside the parts: `src/polaris.ts` (`POLARIS_URL`), `src/navigate.ts` (`useNavigateOnClick`: `href` plus a router `onClick` that leaves modified clicks to the browser), `MemberBar` and `SignOutButton`. `SideNavShell`, `AdminShell`, `MemberShell`, `RouterLink`, `HomePanel` and the Astryx `Theme` and `LinkProvider` are deleted.
    - `BackLink` ("Member area") sits above the member shop page. It is a tertiary `s-button` with `href` and a router `onClick`.
    - `fieldStatus` in `src/form.ts` became `fieldError`, which returns the message string that Polaris fields take as `error`.

    Closed.

    **Review:** Accept. Review checked it in the running app: the field is reachable by role and Shout returns `hi → HI`.

11. **Browser-test setup.** `test/browser/setup.ts` is a Vitest `setupFiles` entry for the browser project. It appends a `<script src={POLARIS_URL}>` and awaits `load` and `customElements.whenDefined("s-page")`. `document.head.append` does not type-check, because `@cloudflare/workers-types` shadows the DOM `append` signature, so it uses `appendChild`. `test-setup.test.tsx` now renders an `s-button`, clicks it, and asserts that `customElements.get("s-button")` is defined and that the element has a shadow root. Closed.

    **Review:** Accept.

12. **The `polaris` CDN ref.** `vp run refs fetch polaris` took 2.3 s. It wrote `refs/polaris/polaris-2.0-rc.min.js` (919,705 bytes) and `polaris-2.0-rc.js` (31,989 lines, formatted by `vp fmt --stdin-filepath=polaris-2.0-rc.js` run from the project root), and stamped `version: 6e07695bfa8765fc73c4746c2293f0c95dc489e1`. `refs list` reports `ok … (build 6e07695b, fetched …; live bundle not checked)`. The ref is included in `--all`. The stamp's `repo` is the CDN origin `https://cdn.shopify.com`, because every ref kind carries one. `download` now returns an optional version, so a kind whose version is known only after download can stamp it. The build hash is parsed with `Schema.TemplateLiteralParser` and a hex `isPattern` check. Closed.

    **Review:** Accept. Review checked `refs/polaris/.ref.json` and both files.

13. **The Shopify docs mirror gains `v2.0-rc`, but `refs/shopify-docs` has not been refreshed.** `scripts/refs-shopify-docs.ts` gained `UNLISTED_VERSIONS` (`app-home/latest` → `app-home/v2.0-rc`) and an `Unlisted` task kind whose 404 counts as "not found" instead of a failure. The full multi-minute mirror was not run. A throwaway copy limited to the `api-app-home` source ran into `/tmp` in 3 s: 99 listed and 98 derived pages, all 197 saved, none missing. The derived pages are genuine (`api_version: v2.0` and `v2.0-rc` source URLs, not redirects to `latest`). Open: run `vp run refs fetch shopify-docs` to put the pages under `refs/shopify-docs/docs/api/app-home/v2.0-rc/`.

    **Review:** Run the full mirror. Done 2026-10-13: `refs/shopify-docs/docs/api/app-home/v2.0-rc/` now has 97 pages. Closed.

14. **Leftover `refs/astryx`.** The `astryx` ref is removed from `scripts/refs.ts`, but the gitignored snapshot directory `refs/astryx/` is still on this machine, and `refs list` no longer reports it. Open: delete it by hand if wanted.

    **Review:** Delete it. Done 2026-10-13. Closed.

15. **Running e2e outside `vp run`.** A direct `vp exec playwright test` fails to start its web server, because the Vite config's guard requires `VP_RUN=1`, which only `vp run` sets. This is the existing guard working as designed, not a regression. A stray `alchemy dev` sidecar from a manual diagnosis also held port 4000 until it was killed. Use `vp run test:e2e [args]`. Closed.

    **Review:** Accept.

16. **Verification.**
    - `vp check --fix` is clean.
    - `vp test`: 13 files, 80 passed and 1 todo. The integ project finished; the known hang did not occur.
    - `vp run test:e2e`: 17 of 17 passed.
    - In the dev server, every screen rendered styled after hydration at 1100px, and the shop page at 390px. The back link and the admin Members link navigate client-side. `.logs/dev/current` showed no errors.

    Closed.

    **Review:** Accept.
