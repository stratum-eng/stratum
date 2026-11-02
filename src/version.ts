/**
 * The running server version.
 *
 * Duplicated from `package.json` rather than imported: pulling JSON into the
 * Worker bundle would need `resolveJsonModule` and would ship the whole
 * manifest to the edge for one string. `tests/source-offer.test.tsx` asserts the
 * two match, which is how this repo pins its other cross-file constants, so a
 * release bump that forgets this line fails CI rather than shipping a stale
 * version to every MCP client's log and every analytics event.
 */
export const STRATUM_VERSION = "0.2.0";

/**
 * Where a visitor to this instance can obtain its source, offered in the page
 * footer.
 *
 * AGPL-3.0 §13: an operator who runs a *modified* Stratum must offer that
 * version's Corresponding Source to everyone who interacts with it over a
 * network — which includes an internal deployment's own developers. Running
 * upstream unmodified carries no such duty, and the default below already
 * points at the source of what is running.
 *
 * If you deploy changes of your own, repoint this at the repository holding
 * them. That single edit discharges the obligation; nothing else in Stratum
 * needs to know. It is deliberately a constant rather than a binding: the
 * answer is fixed for a deployment, and a modified deployment is by definition
 * already editing this file's neighbours.
 */
export const STRATUM_SOURCE_URL = "https://github.com/stratum-eng/stratum";
