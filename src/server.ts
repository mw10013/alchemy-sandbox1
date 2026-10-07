import {
  createStartHandler,
  defaultStreamHandler,
  defineHandlerCallback,
} from "@tanstack/react-start/server";
import { createServerEntry } from "@tanstack/react-start/server-entry";
import { AtomRegistry } from "effect/reactivity";

// This is Start's SSR entry, not a custom Worker entry or hosting adapter.
const handler = defineHandlerCallback(async (context) => {
  context.responseHeaders.set("cache-control", "no-store");
  const registry = AtomRegistry.make();
  context.router.update({
    context: { ...context.router.options.context, probeRegistry: registry },
  });
  context.router.serverSsr?.onCleanup(() => registry.dispose());
  try {
    return await defaultStreamHandler(context);
  } catch (error) {
    registry.dispose();
    throw error;
  }
});
export default createServerEntry({ fetch: createStartHandler(handler) });
