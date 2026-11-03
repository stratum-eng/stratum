import type { FC } from "hono/jsx";

/**
 * Inline form errors, in place of the browser's native validation bubbles.
 *
 * The bubbles are unstyled, vanish on the next keypress, and are never shown
 * at all for a failure only the server can see (a name already taken, a URL
 * that resolves to a private host). The pattern here works for both: the
 * server re-renders the form with the reason under the field it is about, and
 * the control points at that text through `aria-describedby` and announces
 * itself with `aria-invalid`, so a screen reader reads the error on focus.
 *
 * A form opts into this with `novalidate` ONLY where its route validates and
 * re-renders — without the bubble, an unvalidated field would otherwise reach
 * the server and come back as raw JSON.
 */

/** The `id` of the error text for the control with `controlId`. */
export function fieldErrorId(controlId: string): string {
  return `${controlId}-error`;
}

/**
 * Attributes for a control: `aria-invalid` and the error's id in
 * `aria-describedby` while `message` is set, and the help text's id either way
 * (so the rule stays announced once the error is fixed).
 */
export function fieldAttrs(
  controlId: string,
  message: string | undefined,
  helpId?: string,
): { id: string; "aria-invalid"?: "true"; "aria-describedby"?: string } {
  const describedBy = [message !== undefined ? fieldErrorId(controlId) : undefined, helpId]
    .filter((id): id is string => id !== undefined)
    .join(" ");
  return {
    id: controlId,
    ...(message !== undefined ? { "aria-invalid": "true" as const } : {}),
    ...(describedBy !== "" ? { "aria-describedby": describedBy } : {}),
  };
}

/**
 * The error text under a control. Renders nothing without a message, unless
 * `reserve` is set: a page whose script validates before submit needs the
 * element present (and hidden) to write into.
 */
export const FieldError: FC<{ for: string; message?: string | undefined; reserve?: boolean }> = ({
  for: controlId,
  message,
  reserve,
}) => {
  if (message === undefined && !reserve) return null;
  return (
    <p class="field-error" id={fieldErrorId(controlId)} hidden={message === undefined}>
      {message}
    </p>
  );
};
