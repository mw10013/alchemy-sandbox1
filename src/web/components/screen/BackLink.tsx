import { useNavigateOnClick } from "../navigate.ts";

/**
 * The way back to the page this one was opened from, on its own line between the top bar and
 * `s-page`: a tertiary button with a back arrow, named for the target page's heading. Not
 * `s-page`'s `breadcrumb-actions` slot, which a phone folds into a "…" menu beside the heading.
 *
 * `.back-link` in `styles.css` lines it up with the column of `s-page inlineSize="small"`.
 */
export function BackLink({ label, href }: { readonly label: string; readonly href: string }) {
  const navigate = useNavigateOnClick();
  return (
    <div className="back-link">
      <s-button variant="tertiary" icon="arrow-left" {...navigate(href)}>
        {label}
      </s-button>
    </div>
  );
}
