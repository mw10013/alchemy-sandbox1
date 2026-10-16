/**
 * The dev fixture: a fictional made-to-order gift workshop, the shop `vp run fixture` puts this
 * checkout's dev store into. Every name is one a merchant would type, and the orders, placed over
 * the last ten days with the newest numbered highest, read like a working week.
 *
 * Its two halves agree on purpose. The store half (`products`, `storeOrders`) is written into the
 * store through Shopify CLI, and every fixture order item copies a product's title, variant, SKU
 * and tags, so a merchant who follows a workflow's tag to Shopify's product page finds the
 * product the order shows. Fixture orders are numbered from #1201, clear of the numbers Shopify
 * gives the store's real orders.
 *
 * The people: `ana@example.com` is the member persona, on two teams (Engraving and Finishing), so
 * her workflows list has a Team select. Every member is on a team. The odd cases exist to show a
 * screen's rarer states:
 * - `Weekend crew` has nobody, and its workflow, `Weekend engraving`, is the one whose team has no
 *   members; no product carries its tag.
 * - `Packing` has one member and holds `Stamp and bind`'s last step, so deleting it gives "Needs
 *   a team".
 * - `Embroider and fold` has a pending draft; `Frame and glaze` is inactive.
 * - The gift set carries two workflow tags, so two workflows match it; a gift card matches none.
 * - Four orders were closed or changed after work started: fulfilled, cancelled, an item removed,
 *   a quantity resized.
 *
 * Built at module load and decoded through {@link ShopFixture}, so an edit that breaks a rule or a
 * reference fails loudly on import.
 *
 * @module
 */
import * as Schema from "effect/Schema";
import { ShopFixture } from "./src/contract/fixture.ts";

type Encoded = typeof ShopFixture.Encoded;
type Product = Encoded["products"][number];
type Variant = Product["variants"][number];
type Team = Encoded["teams"][number];
type Workflow = Encoded["workflows"][number];
type Task = Workflow["tasks"][number];
type Order = Encoded["orders"][number];
type LineItem = Order["lineItems"][number];
type Progress = NonNullable<LineItem["progress"]>;

const variants = (price: string, ...values: ReadonlyArray<string>): ReadonlyArray<Variant> =>
  values.map((value) => ({ value, price }));

/**
 * The store's products. A product's `handle` is its identity in the store, so writing the fixture
 * again puts a product back the way this table says. The products carry no fixture marker and
 * their tags are real workflow tags, so the store reads as real data.
 */
const products: ReadonlyArray<Product> = [
  {
    handle: "engraved-cutting-board",
    title: "Engraved cutting board",
    option: "Wood",
    variants: variants("68.00", "Maple", "Walnut"),
    skuStem: "CB",
    tags: ["engraved-cutting-board"],
  },
  {
    handle: "leather-journal",
    title: "Leather journal",
    option: "Color",
    variants: variants("42.00", "Tan", "Black"),
    skuStem: "LJ",
    tags: ["leather-journal"],
  },
  {
    handle: "signet-ring",
    title: "Signet ring",
    option: "Metal",
    variants: [
      { value: "Silver", price: "180.00" },
      { value: "Gold", price: "420.00" },
    ],
    skuStem: "SR",
    tags: ["signet-ring"],
  },
  {
    handle: "embroidered-baby-blanket",
    title: "Embroidered baby blanket",
    option: "Color",
    variants: variants("56.00", "Cream", "Sage"),
    skuStem: "BB",
    tags: ["embroidered-blanket"],
  },
  {
    handle: "wall-clock",
    title: "Wall clock",
    option: "Wood",
    variants: variants("95.00", "Oak", "Walnut"),
    skuStem: "WC",
    tags: ["wall-clock"],
  },
  {
    handle: "photo-frame",
    title: "Photo frame",
    option: "Size",
    variants: [
      { value: "5×7", price: "28.00" },
      { value: "8×10", price: "36.00" },
    ],
    skuStem: "PF",
    tags: ["photo-frame"],
  },
  {
    handle: "journal-and-pen-gift-set",
    title: "Journal and pen gift set",
    option: "Color",
    variants: variants("74.00", "Tan", "Black"),
    skuStem: "GS",
    tags: ["leather-journal", "gift-set"],
  },
  {
    handle: "gift-card",
    title: "Gift card",
    option: "Amount",
    variants: [
      { value: "$25", price: "25.00" },
      { value: "$50", price: "50.00" },
    ],
    tags: [],
  },
];

/**
 * `<stem>-<VALUE>`, the value upper-cased with `×` as `X` and anything else that is not a letter
 * or digit dropped; `null` for a product with no SKU stem.
 */
export const skuOf = (
  product: { readonly skuStem?: string | undefined },
  value: string,
): string | null =>
  product.skuStem === undefined
    ? null
    : `${product.skuStem}-${value
        .toUpperCase()
        .replaceAll("×", "X")
        .replaceAll(/[^A-Z0-9]/gu, "")}`;

/**
 * The three real orders the store keeps open, each found again by its own tag. The dev stores
 * already hold orders with these tags, so they must not change.
 */
const storeOrders: Encoded["storeOrders"] = [
  {
    tag: "seed-board",
    lines: [
      {
        handle: "engraved-cutting-board",
        value: "Maple",
        quantity: 1,
        properties: { "Engraving text": "The Bakers" },
      },
    ],
  },
  {
    tag: "seed-journal",
    lines: [
      { handle: "leather-journal", value: "Tan", quantity: 1, properties: { Initials: "E.M.R." } },
    ],
  },
  {
    tag: "seed-clock-and-blanket",
    lines: [
      { handle: "wall-clock", value: "Oak", quantity: 1, properties: { Numerals: "Roman" } },
      {
        handle: "embroidered-baby-blanket",
        value: "Cream",
        quantity: 1,
        properties: { "Name to embroider": "Mia" },
      },
    ],
  },
];

const ANA = "ana@example.com";
const BEN = "ben@example.com";
const CARMEN = "carmen@example.com";
const DANA = "dana@example.com";
const ELI = "eli@example.com";
const FARAH = "farah@example.com";
const GUS = "gus@example.com";

const WOODSHOP = "Woodshop";
const ENGRAVING = "Engraving";
const LEATHER = "Leather";
const JEWELRY = "Jewelry";
const TEXTILES = "Textiles";
const FINISHING = "Finishing";
const PACKING = "Packing";
const WEEKEND_CREW = "Weekend crew";

const members = [ANA, BEN, CARMEN, DANA, ELI, FARAH, GUS];

const teams: ReadonlyArray<Team> = [
  { name: WOODSHOP, members: [BEN, DANA] },
  { name: ENGRAVING, members: [ANA, BEN, CARMEN] },
  { name: LEATHER, members: [CARMEN, ELI] },
  { name: JEWELRY, members: [FARAH] },
  { name: TEXTILES, members: [DANA] },
  { name: FINISHING, members: [ANA, ELI] },
  { name: PACKING, members: [GUS] },
  { name: WEEKEND_CREW, members: [] },
];

const product = (handle: string): Product => {
  const found = products.find((entry) => entry.handle === handle);
  if (found === undefined) throw new Error(`no fixture product ${handle}`);
  return found;
};

const BOARD = product("engraved-cutting-board");
const JOURNAL = product("leather-journal");
const RING = product("signet-ring");
const BLANKET = product("embroidered-baby-blanket");
const CLOCK = product("wall-clock");
const FRAME = product("photo-frame");
const GIFT_SET = product("journal-and-pen-gift-set");
const GIFT_CARD = product("gift-card");

/** The first tag of a product one workflow follows. */
const tagOf = (entry: Product): string => {
  const [tag] = entry.tags;
  if (tag === undefined) throw new Error(`${entry.handle} has no tag`);
  return tag;
};

const task = (name: string, team: string, instructions: string, step?: number): Task => ({
  name,
  team,
  instructions,
  ...(step === undefined ? {} : { step }),
});

const EMBROIDER = task(
  "Embroider name",
  TEXTILES,
  "The name and thread colour are in the properties. Test the stitch on a scrap first.",
);
const FOLD_AND_WRAP = task(
  "Fold and wrap",
  FINISHING,
  "Steam out the creases, fold in thirds and wrap in tissue.",
);

/**
 * A workflow's tag is its product's first tag, except two literals: the gift set's first tag is
 * `leather-journal`, which `Stamp and bind` already has, and no product carries
 * `weekend-engraving`.
 */
const workflows: ReadonlyArray<Workflow> = [
  {
    name: "Cut, engrave and oil",
    tag: tagOf(BOARD),
    tasks: [
      task(
        "Cut and sand",
        WOODSHOP,
        "Cut to the size on the order. Sand to 220 grit and check the end grain for tear-out.",
      ),
      task(
        "Engrave",
        ENGRAVING,
        "The text is in the properties. Check the spelling against the order before running the laser.",
      ),
      task(
        "Oil and inspect",
        FINISHING,
        "Two coats of food-safe oil, 20 minutes apart. Look for rough spots in the light.",
      ),
    ],
  },
  {
    name: "Stamp and bind",
    tag: tagOf(JOURNAL),
    tasks: [
      task("Cut cover", LEATHER, "Cut the cover from the marked hide, grain side up."),
      task(
        "Stamp initials",
        ENGRAVING,
        "The initials are in the properties. Centre them on the front cover.",
      ),
      task("Bind", LEATHER, "Stitch the signatures to the spine and glue the cover on."),
      task("Pack", PACKING, "Wrap in tissue and put it in a gift box with the card."),
    ],
  },
  {
    name: "Cast, engrave, polish",
    tag: tagOf(RING),
    tasks: [
      task(
        "Cast",
        JEWELRY,
        "Ring size and metal are in the properties. Cast one size up for finishing.",
      ),
      task("Engrave crest", ENGRAVING, "The crest file is named after the order number."),
      task(
        "Polish",
        JEWELRY,
        "High polish unless the order says brushed. Check the size on the mandrel.",
      ),
    ],
  },
  {
    name: "Embroider and fold",
    tag: tagOf(BLANKET),
    tasks: [EMBROIDER, FOLD_AND_WRAP],
    draft: {
      tasks: [
        EMBROIDER,
        task("Sew in care label", TEXTILES, "Sew the label into the bottom left seam."),
        FOLD_AND_WRAP,
      ],
    },
  },
  {
    name: "Clock assembly",
    tag: tagOf(CLOCK),
    tasks: [
      task("Cut face", WOODSHOP, "Cut the face to 30 cm and drill the centre hole.", 1),
      task("Engrave numerals", ENGRAVING, "The numeral style is in the properties.", 1),
      task(
        "Assemble",
        FINISHING,
        "Fit the movement and the hands, then check the time against a reference clock.",
        2,
      ),
    ],
  },
  {
    name: "Frame and glaze",
    state: "inactive",
    tag: tagOf(FRAME),
    tasks: [
      task("Cut mat", WOODSHOP, "Cut the mat to the frame size."),
      task("Glaze and fit", FINISHING, "Clean the glass and fit the backing."),
    ],
  },
  {
    name: "Gift set assembly",
    tag: "gift-set",
    tasks: [
      task(
        "Assemble set",
        FINISHING,
        "Put the journal and the pen in the gift box and tie the ribbon.",
      ),
    ],
  },
  {
    name: "Weekend engraving",
    tag: "weekend-engraving",
    tasks: [task("Engrave", WEEKEND_CREW, "Weekend jobs are engraved on Saturday morning.")],
  },
];

/**
 * One line of an order: a product's own title, variant, SKU and tags, with the properties the
 * customer typed.
 */
const line = (
  entry: Product,
  value: string,
  quantity: number,
  properties: Readonly<Record<string, string>> = {},
  extra: Pick<LineItem, "currentQuantity" | "progress" | "workflow"> = {},
): LineItem => {
  const sku = skuOf(entry, value);
  return {
    title: entry.title,
    variantTitle: value,
    ...(sku === null ? {} : { sku }),
    quantity,
    tags: entry.tags,
    properties: Object.entries(properties).map(([key, text]) => ({ key, value: text })),
    ...extra,
  };
};

const ENGRAVING_TEXT = "Engraving text";

/** An order before it has a number and a date; both come from its place in {@link orders}. */
type OrderSpec = Omit<Order, "n" | "placedDaysAgo">;

const notStarted: ReadonlyArray<OrderSpec> = [
  { lineItems: [line(BOARD, "Maple", 1, { [ENGRAVING_TEXT]: "The Hendersons" })] },
  { lineItems: [line(BOARD, "Walnut", 2, { [ENGRAVING_TEXT]: "Ella and Marcus, 2024" })] },
  { lineItems: [line(JOURNAL, "Tan", 1, { Initials: "R.K.W." })] },
  { lineItems: [line(RING, "Silver", 1, { "Ring size": "9" })] },
  { lineItems: [line(BLANKET, "Cream", 1, { "Name to embroider": "Olivia" })] },
  { lineItems: [line(CLOCK, "Oak", 1, { Numerals: "Roman" })] },
  { lineItems: [line(JOURNAL, "Black", 1, { Initials: "T.B." })] },
  // The merchant chose one of the two workflows that match a gift set.
  { lineItems: [line(GIFT_SET, "Tan", 1, {}, { workflow: "Gift set assembly" })] },
];

const startedByAna: ReadonlyArray<OrderSpec> = [
  {
    lineItems: [
      line(
        BOARD,
        "Maple",
        1,
        { [ENGRAVING_TEXT]: "Grandma Rose" },
        { progress: { advance: 1, started: true, by: ANA } },
      ),
    ],
  },
  {
    lineItems: [
      line(
        JOURNAL,
        "Tan",
        1,
        { Initials: "S.A.L." },
        { progress: { advance: 1, started: true, by: ANA } },
      ),
    ],
  },
  {
    lineItems: [
      line(
        RING,
        "Gold",
        1,
        { "Ring size": "7" },
        { progress: { advance: 1, started: true, by: ANA } },
      ),
    ],
  },
  {
    lineItems: [
      line(
        BOARD,
        "Walnut",
        1,
        { [ENGRAVING_TEXT]: "Home sweet home" },
        { progress: { advance: 2, started: true, by: ANA } },
      ),
    ],
  },
  {
    lineItems: [
      line(
        BLANKET,
        "Sage",
        1,
        { "Name to embroider": "Theodore" },
        { progress: { advance: 1, started: true, by: ANA } },
      ),
    ],
  },
];

const startedBy = (
  by: string,
  entry: Product,
  value: string,
  properties: Readonly<Record<string, string>>,
  progress: Progress = {},
): OrderSpec => ({
  lineItems: [line(entry, value, 1, properties, { progress: { started: true, ...progress, by } })],
});

const startedByOthers: ReadonlyArray<OrderSpec> = [
  startedBy(BEN, BOARD, "Walnut", { [ENGRAVING_TEXT]: "Welcome" }, { advance: 1 }),
  startedBy(BEN, BOARD, "Maple", { [ENGRAVING_TEXT]: "The Parks" }, { advance: 1 }),
  startedBy(CARMEN, JOURNAL, "Black", { Initials: "M.J." }, { advance: 1 }),
  startedBy(FARAH, RING, "Silver", { "Ring size": "6" }),
  startedBy(DANA, BLANKET, "Cream", { "Name to embroider": "Ava" }),
  startedBy(BEN, CLOCK, "Walnut", { Numerals: "Arabic" }),
  startedBy(CARMEN, JOURNAL, "Tan", { Initials: "D.L.H." }, { advance: 2 }),
  startedBy(ELI, BOARD, "Maple", { [ENGRAVING_TEXT]: "Bon appétit" }, { advance: 2 }),
];

const betweenSteps = (
  by: string,
  entry: Product,
  value: string,
  properties: Readonly<Record<string, string>>,
  advance: number,
): OrderSpec => ({
  lineItems: [line(entry, value, 1, properties, { progress: { advance, by } })],
});

const makingBetweenSteps: ReadonlyArray<OrderSpec> = [
  betweenSteps(BEN, BOARD, "Maple", { [ENGRAVING_TEXT]: "Nana's kitchen" }, 1),
  betweenSteps(ELI, BOARD, "Walnut", { [ENGRAVING_TEXT]: "Cheers" }, 2),
  betweenSteps(CARMEN, JOURNAL, "Tan", { Initials: "P.N." }, 1),
  betweenSteps(FARAH, RING, "Silver", { "Ring size": "8" }, 1),
  // The journals at the last step, Pack: the ones that need a team when Packing is deleted.
  betweenSteps(CARMEN, JOURNAL, "Black", { Initials: "C.O." }, 3),
  betweenSteps(CARMEN, JOURNAL, "Tan", { Initials: "J.F." }, 3),
];

const blocked: ReadonlyArray<OrderSpec> = [
  {
    lineItems: [
      line(
        BOARD,
        "Walnut",
        1,
        { [ENGRAVING_TEXT]: "Smith family" },
        {
          progress: {
            advance: 1,
            by: ANA,
            blocked: "The board has a crack along the grain. Asked for a new blank.",
          },
        },
      ),
    ],
  },
  {
    lineItems: [
      line(
        RING,
        "Gold",
        1,
        { "Ring size": "10" },
        {
          progress: {
            advance: 1,
            byMerchant: true,
            blocked: "The customer is changing the crest. Waiting for the new file.",
          },
        },
      ),
    ],
  },
];

const made: ReadonlyArray<OrderSpec> = [
  {
    lineItems: [
      line(
        BOARD,
        "Maple",
        1,
        { [ENGRAVING_TEXT]: "Fresh bread" },
        { progress: { done: true, by: ELI } },
      ),
    ],
  },
  {
    lineItems: [
      line(
        BLANKET,
        "Cream",
        1,
        { "Name to embroider": "Noah" },
        { progress: { done: true, by: DANA } },
      ),
    ],
  },
  {
    lineItems: [
      line(JOURNAL, "Black", 1, { Initials: "A.B." }, { progress: { done: true, by: CARMEN } }),
    ],
  },
  {
    lineItems: [
      line(RING, "Silver", 1, { "Ring size": "7" }, { progress: { done: true, by: FARAH } }),
      line(
        BLANKET,
        "Sage",
        1,
        { "Name to embroider": "Ivy" },
        { progress: { done: true, by: DANA } },
      ),
    ],
  },
];

const oddOnes: ReadonlyArray<OrderSpec> = [
  // Two workflows match a gift set and nobody chose: no workflow until the merchant picks one.
  { lineItems: [line(GIFT_SET, "Black", 1)] },
  // Nothing to follow: a gift card alone, and one beside a board, whose run is the order's.
  { lineItems: [line(GIFT_CARD, "$50", 1)] },
  {
    lineItems: [
      line(GIFT_CARD, "$25", 1),
      line(BOARD, "Maple", 1, { [ENGRAVING_TEXT]: "Merry Christmas" }),
    ],
  },
  // Unpaid: no runs until it is paid.
  { unpaid: true, lineItems: [line(BOARD, "Walnut", 1, { [ENGRAVING_TEXT]: "Thank you" })] },
  // Three items in three states, with an order note, SKUs, properties and a run note.
  {
    note: "Gift for Sam's wedding on the 14th. Please pack everything in one box.",
    lineItems: [
      line(
        BOARD,
        "Walnut",
        1,
        { [ENGRAVING_TEXT]: "Sam and Priya, 14 October" },
        {
          progress: {
            advance: 1,
            started: true,
            by: ANA,
            note: "Customer confirmed the spelling of Priya by email.",
          },
        },
      ),
      line(JOURNAL, "Tan", 1, { Initials: "S.P." }, { progress: { done: true, by: ELI } }),
      line(CLOCK, "Oak", 1, { Numerals: "Roman" }),
    ],
  },
];

/** The four ways an order closes or changes, placed longest ago so they sit at the bottom. */
const closed: ReadonlyArray<OrderSpec> = [
  {
    fulfillmentStatus: "UNFULFILLED",
    after: { fulfillmentStatus: "FULFILLED" },
    lineItems: [
      line(
        BOARD,
        "Maple",
        1,
        { [ENGRAVING_TEXT]: "Happy retirement" },
        { progress: { done: true, by: ELI } },
      ),
    ],
  },
  {
    after: { cancelled: true },
    lineItems: [
      line(JOURNAL, "Tan", 1, { Initials: "G.H." }, { progress: { advance: 1, by: CARMEN } }),
    ],
  },
  {
    after: { lineItems: [{ position: 2, currentQuantity: 0 }] },
    lineItems: [
      line(
        BLANKET,
        "Sage",
        1,
        { "Name to embroider": "Leo" },
        { progress: { advance: 1, by: DANA } },
      ),
      line(RING, "Silver", 1, { "Ring size": "8" }, { progress: { advance: 1, by: FARAH } }),
    ],
  },
  {
    after: { lineItems: [{ position: 1, currentQuantity: 1 }] },
    lineItems: [
      line(
        BOARD,
        "Walnut",
        2,
        { [ENGRAVING_TEXT]: "Cabin" },
        { progress: { advance: 1, by: BEN } },
      ),
    ],
  },
];

/** Takes one from each group in turn, so the kinds are spread through the orders index. */
const interleave = <T>(groups: ReadonlyArray<ReadonlyArray<T>>): ReadonlyArray<T> =>
  Array.from({ length: Math.max(...groups.map((group) => group.length)) }, (_, index) =>
    groups.flatMap((group) => {
      const entry = group[index];
      return entry === undefined ? [] : [entry];
    }),
  ).flat();

const specs: ReadonlyArray<OrderSpec> = [
  ...closed,
  ...interleave([
    notStarted,
    startedByAna,
    startedByOthers,
    makingBetweenSteps,
    blocked,
    made,
    oddOnes,
  ]),
];

/** Numbered from #1201 upward, oldest first: ten days ago for the first, today for the last. */
const orders: ReadonlyArray<Order> = specs.map((spec, index) => ({
  ...spec,
  n: 1201 + index,
  placedDaysAgo: Math.floor(((specs.length - 1 - index) * 10) / (specs.length - 1)),
}));

export const fixture: ShopFixture = Schema.decodeUnknownSync(ShopFixture)({
  products,
  storeOrders,
  members,
  teams,
  workflows,
  orders,
} satisfies Encoded);
