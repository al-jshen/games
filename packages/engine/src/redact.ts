/**
 * Hidden-information safety, enforced by the type system.
 *
 * A game has two distinct shapes: the server's truth state (deck order, the opponent's secret
 * reservations, the RNG seed) and the per-viewer wire view. Keeping them as different types turns
 * "did I remember to redact?" from a code-review question into a compile error: the transport
 * only accepts `Redacted<T>`, and the only way to mint one is `seal()`, which lives inside a
 * game module's `redactFor`.
 */

declare const REDACTED: unique symbol;

/** A value that has passed through a game module's `redactFor` and is safe to send. */
export type Redacted<V> = V & { readonly [REDACTED]: true };

/**
 * Mark a view as safe to transmit. Call this **only** as the final step of `redactFor`, on a
 * value built up from scratch — never on the truth state with a few fields deleted.
 */
export function seal<V>(view: V): Redacted<V> {
  return view as Redacted<V>;
}

/** Strip the brand, e.g. to feed a view back into `apply` for client-side prediction. */
export function unseal<V>(view: Redacted<V>): V {
  return view;
}

/**
 * Test helper: does any of `secrets` leak into the serialised view?
 *
 * Catches the obvious failures (a seed or hidden card id copied through). It does **not** catch
 * leaks by array length, key order, or payload size — for those you need the view-stability
 * property: two truth states differing only in what the viewer cannot see must serialise
 * byte-identically. Both checks belong in every game's test suite.
 */
export function findLeakedSecrets(view: unknown, secrets: readonly string[]): string[] {
  if (secrets.length === 0) return [];
  const json = JSON.stringify(view) ?? '';
  return secrets.filter((s) => s.length > 0 && json.includes(s));
}
