/**
 * The dev shop's seed: the products and open orders `stores:seed` writes into a dev store, a
 * fictional made-to-order gift workshop. The products and the three orders are also what the help
 * pages' screenshots are taken against. A product's `handle` is its identity in the store, so
 * seeding can run again and put a product back the way this table says. The products carry no seed
 * marker and their tags are real workflow tags, so the store reads as real data; only orders are
 * marked.
 *
 * @module
 */

export interface Variant {
  readonly value: string;
  readonly price: string;
}

export interface Product {
  readonly handle: string;
  readonly title: string;
  /** The name of the one product option; its values are the variants. */
  readonly option: string;
  readonly variants: readonly Variant[];
  /** Left out: the variants carry no SKU. See {@link skuOf}. */
  readonly skuStem?: string;
  /** Workflow tags, as the workflows match them; empty for a product no workflow follows. */
  readonly tags: readonly string[];
}

export interface OrderLine {
  readonly handle: string;
  /** The value of the product's option, which names the variant. */
  readonly value: string;
  readonly quantity: number;
  /** What a customer would have typed into the product's line properties. */
  readonly properties: Readonly<Record<string, string>>;
}

export interface Order {
  /** Marks the order in the store, so a second run finds it instead of creating it again. */
  readonly tag: string;
  readonly lines: readonly OrderLine[];
}

const variants = (price: string, ...values: readonly string[]): readonly Variant[] =>
  values.map((value) => ({ value, price }));

export const products: readonly Product[] = [
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
 * The three real orders kept open, each recognised by its own tag beside the seed marker. Every line
 * names a product in {@link products} and one of its option values.
 */
export const orders: readonly Order[] = [
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
      {
        handle: "leather-journal",
        value: "Tan",
        quantity: 1,
        properties: { Initials: "E.M.R." },
      },
    ],
  },
  {
    tag: "seed-clock-and-blanket",
    lines: [
      {
        handle: "wall-clock",
        value: "Oak",
        quantity: 1,
        properties: { Numerals: "Roman" },
      },
      {
        handle: "embroidered-baby-blanket",
        value: "Cream",
        quantity: 1,
        properties: { "Name to embroider": "Mia" },
      },
    ],
  },
];

/**
 * `<stem>-<VALUE>`, the value upper-cased with `×` as `X` and anything else that is not a letter
 * or digit dropped; `null` for a product with no SKU stem.
 */
export const skuOf = (product: Product, value: string): string | null =>
  product.skuStem === undefined
    ? null
    : `${product.skuStem}-${value
        .toUpperCase()
        .replaceAll("×", "X")
        .replaceAll(/[^A-Z0-9]/gu, "")}`;
