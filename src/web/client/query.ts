import { createIsomorphicFn } from "@tanstack/react-start";
import * as Atom from "effect/reactivity/Atom";

/** `windowFocusSignal` reads `window` and `document`, so the server keeps the atom as is. */
const refreshOnFocusImpl = createIsomorphicFn()
  .client((atom: Atom.Atom<any>) => Atom.refreshOnWindowFocus(atom))
  .server((atom: Atom.Atom<any>) => atom);

/** Refetches `atom` when the tab becomes visible again. A no-op on the server. */
export const refreshOnFocus = <A extends Atom.Atom<any>>(atom: A): A =>
  // createIsomorphicFn infers non-generic args, so restore the atom's type here.
  refreshOnFocusImpl(atom) as A;
