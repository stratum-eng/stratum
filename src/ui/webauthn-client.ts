/**
 * Browser half of the passkey ceremonies (#256), served as an inline,
 * CSP-nonce'd script on the two pages that need it: `/auth/2fa` and
 * `/settings/security`.
 *
 * Why inline rather than bundling `@simplewebauthn/browser`: this app has no
 * client build step and serves no first-party script files (see AGENTS.md), and
 * all the browser library does for us is convert between the JSON options the
 * server emits and the ArrayBuffers `navigator.credentials` wants. That is the
 * forty lines below. WebAuthn cannot run without JavaScript, so these pages are
 * the one place a script is required rather than a progressive enhancement —
 * and the second-factor page still offers a no-JS recovery-code form.
 *
 * Exposes `window.StratumPasskey.{create,get,supported}`.
 */
export const WEBAUTHN_CLIENT_SCRIPT = `(function () {
  function toBuf(s) {
    s = String(s).replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    var bin = atob(s);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }
  function toB64u(buf) {
    var bytes = new Uint8Array(buf);
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  }
  function descriptors(list) {
    return (list || []).map(function (d) {
      return { id: toBuf(d.id), type: d.type || "public-key", transports: d.transports };
    });
  }
  function extensionResults(cred) {
    try { return cred.getClientExtensionResults(); } catch (e) { return {}; }
  }
  async function create(options) {
    var publicKey = Object.assign({}, options, {
      challenge: toBuf(options.challenge),
      user: Object.assign({}, options.user, { id: toBuf(options.user.id) }),
      excludeCredentials: descriptors(options.excludeCredentials),
    });
    var cred = await navigator.credentials.create({ publicKey: publicKey });
    var r = cred.response;
    return {
      id: cred.id,
      rawId: toB64u(cred.rawId),
      type: cred.type,
      clientExtensionResults: extensionResults(cred),
      authenticatorAttachment: cred.authenticatorAttachment || undefined,
      response: {
        clientDataJSON: toB64u(r.clientDataJSON),
        attestationObject: toB64u(r.attestationObject),
        transports: typeof r.getTransports === "function" ? r.getTransports() : [],
      },
    };
  }
  async function get(options) {
    var publicKey = Object.assign({}, options, {
      challenge: toBuf(options.challenge),
      allowCredentials: descriptors(options.allowCredentials),
    });
    var cred = await navigator.credentials.get({ publicKey: publicKey });
    var r = cred.response;
    return {
      id: cred.id,
      rawId: toB64u(cred.rawId),
      type: cred.type,
      clientExtensionResults: extensionResults(cred),
      authenticatorAttachment: cred.authenticatorAttachment || undefined,
      response: {
        clientDataJSON: toB64u(r.clientDataJSON),
        authenticatorData: toB64u(r.authenticatorData),
        signature: toB64u(r.signature),
        userHandle: r.userHandle ? toB64u(r.userHandle) : undefined,
      },
    };
  }
  window.StratumPasskey = {
    supported: typeof window.PublicKeyCredential === "function" && !!navigator.credentials,
    create: create,
    get: get,
  };
})();`;
