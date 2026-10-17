import { describe, it } from "@effect/vitest";
import { deepStrictEqual, strictEqual } from "@effect/vitest/utils";
import { capProperties, syncOrder } from "../../../src/domain/orders.ts";
import { retentionCutoff, ShopLimits } from "../../../src/domain/platform.ts";

/**
 * `ShopLimits.maxPropertiesBytesPerItem`: the prefix whose JSON fits is
 * kept, in order, and everything from the first property that overflows on is
 * dropped.
 */
const smallProperty = (key: string) => ({ key, value: "x".repeat(100) });

describe("Domain.capProperties", () => {
  it("keeps the properties that fit in 8 KB and drops the rest", () => {
    const cap = ShopLimits.maxPropertiesBytesPerItem;
    strictEqual(cap, 8192);
    const overflowing = [
      smallProperty("a"),
      smallProperty("b"),
      { key: "proof", value: "x".repeat(cap) },
      smallProperty("c"),
    ];
    const capped = capProperties(overflowing);
    deepStrictEqual(capped.kept, [smallProperty("a"), smallProperty("b")]);
    strictEqual(capped.dropped, 2);
    deepStrictEqual(capProperties([]), { kept: [], dropped: 0 });
    deepStrictEqual(capProperties([{ key: "proof", value: "x".repeat(cap) }]), {
      kept: [],
      dropped: 1,
    });
    // The cap is on the stored JSON, in UTF-8 bytes: a list that encodes to
    // exactly the cap is kept whole, and one byte more drops its last.
    const exact = [{ key: "k", value: "" }];
    const base = new TextEncoder().encode(JSON.stringify(exact)).length;
    const atCap = [{ key: "k", value: "é".repeat((cap - base) / 2) }];
    strictEqual(new TextEncoder().encode(JSON.stringify(atCap)).length, cap);
    deepStrictEqual(capProperties(atCap), { kept: atCap, dropped: 0 });
    deepStrictEqual(capProperties([{ key: "k", value: `${atCap[0].value}a` }]), {
      kept: [],
      dropped: 1,
    });
  });
});

/**
 * The actions table on `syncOrder`, one entry per row: `title` is the row's
 * five cells joined with ` | `, and `fixtures` is every input the row stands
 * for, each `any` read as every other word of its column.
 */
const SYNC_ROWS = [
  {
    title: "none | any | expired | any | refuse: retention; nothing written, nothing flagged",
    action: { tag: "refuse", note: "retention; nothing written, nothing flagged" },
    fixtures: [
      { stored: "none", version: "older", age: "expired", ceiling: "at" },
      { stored: "none", version: "older", age: "expired", ceiling: "under" },
      { stored: "none", version: "same or newer", age: "expired", ceiling: "at" },
      { stored: "none", version: "same or newer", age: "expired", ceiling: "under" },
    ],
  },
  {
    title: "none | any | kept | at | refuse: ceiling; `ordersLimitedAt` set",
    action: { tag: "refuse", note: "ceiling; `ordersLimitedAt` set" },
    fixtures: [
      { stored: "none", version: "older", age: "kept", ceiling: "at" },
      { stored: "none", version: "same or newer", age: "kept", ceiling: "at" },
    ],
  },
  {
    title: "none | any | kept | under | write: fresh; items inserted; reconcile",
    action: { tag: "write", note: "fresh; items inserted; reconcile" },
    fixtures: [
      { stored: "none", version: "older", age: "kept", ceiling: "under" },
      { stored: "none", version: "same or newer", age: "kept", ceiling: "under" },
    ],
  },
  {
    title: "stored | older | any | any | skip: the row and its items stay",
    action: { tag: "skip", note: "the row and its items stay" },
    fixtures: [
      { stored: "stored", version: "older", age: "expired", ceiling: "at" },
      { stored: "stored", version: "older", age: "expired", ceiling: "under" },
      { stored: "stored", version: "older", age: "kept", ceiling: "at" },
      { stored: "stored", version: "older", age: "kept", ceiling: "under" },
    ],
  },
  {
    title:
      "stored | same or newer | any | any | write: row rewritten except `countedAt`; items replaced; reconcile",
    action: { tag: "write", note: "row rewritten except `countedAt`; items replaced; reconcile" },
    fixtures: [
      { stored: "stored", version: "same or newer", age: "expired", ceiling: "at" },
      { stored: "stored", version: "same or newer", age: "expired", ceiling: "under" },
      { stored: "stored", version: "same or newer", age: "kept", ceiling: "at" },
      { stored: "stored", version: "same or newer", age: "kept", ceiling: "under" },
    ],
  },
] as const;

describe("Domain.syncOrder actions", () => {
  const SYNCED_AT = Date.UTC(2026, 9, 1);
  const DAY = 86_400_000;
  const STORED_VERSION = 100;
  const versions = { older: [50], "same or newer": [100, 150] } as const;
  const ages = {
    expired: retentionCutoff(SYNCED_AT) - DAY,
    kept: retentionCutoff(SYNCED_AT) + DAY,
  } as const;
  for (const row of SYNC_ROWS)
    it(row.title, () => {
      for (const fixture of row.fixtures)
        for (const updatedAt of versions[fixture.version]) {
          const action = syncOrder({
            stored: fixture.stored === "none" ? null : { updatedAt: STORED_VERSION },
            incoming: {
              updatedAt,
              processedAt: ages[fixture.age],
              syncedAt: SYNCED_AT,
            },
            atCeiling: fixture.ceiling === "at",
          });
          const where = JSON.stringify({ ...fixture, updatedAt });
          strictEqual(action._tag, row.action.tag, where);
          if (action._tag === "write")
            strictEqual(action.fresh, row.action.note.startsWith("fresh"), where);
          if (action._tag === "refuse")
            strictEqual(action.reason, row.action.note.split(";")[0], where);
        }
    });
});
