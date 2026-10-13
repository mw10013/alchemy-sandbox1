# AGENTS.md

## Git
- Do not git commit unless you are explicitly instructed.
- Commit only to the branch checked out where you work: `main` in the main checkout, `wt-NN` in a worktree. Create no other branches, except a new `wt-NN` when setting up a worktree.

## Toolchain
Vite+. Never npm or npx.
- Run `vp check --fix` after code changes (format, lint, type check). Plain `vp check` is for CI or read-only verification.
- Tests: `vp test` (unit, browser, integ); `vp run test:e2e` (e2e).

## Effect
- Validation, parsing, encoding: Effect Schema. Never trim, length-check or regex-test input by hand.
- Tag dispatch: `Match`. Errors: `Schema.TaggedError`. Reusable effects: `Effect.fn("name")`.
- Effect's own idiom guide is in `refs/effect/ai-docs/src` and `refs/effect/LLMS.md`.

## Comments
- Document a declaration with JSDoc on the symbol, never a `//` above it: JSDoc shows on hover and at every use, and its `{@link}`s follow renames.
- JSDoc says what the code cannot: a rule, a non-obvious why, a platform or library constraint. Never what the name and type already say.
- State a rule once, on the symbol that enforces it or is the concept. Other sites `{@link}` it instead of restating it; a site that deviates says so and why.
- Reference code with `{@link Symbol}`, never a file name. A link resolves only to a symbol in scope (declared or imported, `{@link Module.member}` included); never import just for a link, name the symbol in backticks instead. `@see` for an external URL or a `refs/` path (file plus heading or symbol, never a line number).
- Tags: `{@link}`, `@see`, `@example` for a pattern to copy, `@deprecated`. `@param`/`@returns` only when a parameter means something its type does not. No `@throws`: Effect errors are in the type.
- `//` only for a why that belongs to one line or branch inside a body.
- Never reference plans or research docs; they go stale and get deleted. State the reason in the comment itself.

## Dev server
Start with `vp run dev`. Open `http://localhost:$(pnpm port)`. Plain `vp dev` is blocked because it bypasses Alchemy.

## Logs
Dev logs: `.logs/dev/current`. Rotated archives: `.logs/dev/`.
Staging logs: use `cf o11y telemetry query` on `cloudflare-workers`, filtering `$metadata.service` to `alchemy-sandbox1-website-staging-a6uwn3bzazl3yzgy`.

<!-- ASTRYX:START -->
Astryx v0.6.5 · 166 components
CLI: run every command as `vp exec astryx <cmd>` (shown below as `astryx ...`).

SETUP (once, in your app entry e.g. main.tsx) — without these, components render unstyled:
  import "@astryxdesign/core/reset.css";
  import "@astryxdesign/core/astryx.css";

WORKFLOW — start every page from a template. Never lay out a page from scratch:
1. `astryx build "<idea>"` — START HERE: names the [page] template to start from (always one: the closest match, or the app shell), two other templates, and the [block]s + [component]s for parts it lacks. No args = full playbook.
2. `astryx template <name> <path>` — scaffold that template into your project. Keep its frame, gap and padding; replace its data, copy and sections; delete sections you do not need.
3. `astryx template <Block>` for a part the template lacks; `astryx component <Name>` for props + examples before you use or change a component.
Changing a page you already have? Keep it: skip step 2 and add blocks and components inside its sections.

RULES:
- No <div> — components do all layout/spacing, page frame included.
- Frame first: the template you scaffold sets the page frame. Read `astryx docs layout` before you change it — region widths, breakpoint behavior.
- Dense data = rows (Table, List/Item), never Card-wrapped list items; Card is for standalone widgets. Status = StatusDot/Token; Badge = counts only.
- Custom styling: component props first; else style/className with tokens — var(--color-*|--spacing-*|--radius-*). No raw hex/px. (No StyleX/Tailwind compiler here — don't use xstyle/utility classes.)
- Tokens for every value (`astryx docs tokens`). Brand/accent belongs in the theme (`astryx theme list` / `theme add <slug>`, or `astryx theme template` for a custom one) — never override --color-* in :root.
- SELF-CHECK before you finish: re-read the file and replace any raw <div>/<span> layout, imported .css/@apply, or hardcoded value (#hex, 16px) with the component or a token (var(--color-*|--spacing-*|…)). Confirm the page kept its template's frame, gap and padding. If unsure a component/prop exists, run `astryx component <Name>` / `astryx search "<thing>"`; don't hand-roll CSS.

MORE CLI:
  search "<query>"   find any component / hook / doc / template / block
  component --list   166 components by category
  template --list    page + block recipes
  docs <topic>       authoring, browser-support, color, elevation, getting-started, icons, illustrations, internationalization, layout, migration, motion, principles, shape, spacing, styling-libraries, styling, theme, tokens, typography, working-with-ai
  docs cli           commands, API reference, integration authoring (one level at a time)
  swizzle <Name>     eject component source for deep customization
  upgrade --from <old version> --apply   run after any Astryx or integration dependency bump
<!-- ASTRYX:END -->
