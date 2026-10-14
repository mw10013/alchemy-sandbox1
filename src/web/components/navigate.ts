import { useRouter } from "@tanstack/react-router";

const MODIFIERS = ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const;

/**
 * `href` and an `onClick` for an `s-link` or `s-button` that should navigate client-side.
 * Outside the Shopify admin nothing intercepts the anchor Polaris renders, so an `href` alone is
 * a full document load. The `href` keeps open-in-new-tab working; a click with a modifier key is
 * left to the browser.
 */
export const useNavigateOnClick = () => {
  const router = useRouter();
  return (href: string) => ({
    href,
    // Polaris types the event as `Event`; React hands its synthetic mouse event, so the modifier
    // keys are read by name rather than through `instanceof MouseEvent`.
    onClick: (event: Event) => {
      if (MODIFIERS.some((key) => key in event && Reflect.get(event, key) === true)) return;
      event.preventDefault();
      void router.navigate({ href });
    },
  });
};
