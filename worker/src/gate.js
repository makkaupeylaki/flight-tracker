// Shared-password gate. When the GATE_PASSWORD secret is set, every API answer
// needs the fl_gate cookie that the Pages lock screen (web/functions/_middleware.js)
// sets after the right password. Delete the secret to open the site again -
// no redeploy needed. Keep this file and that middleware copy in sync.

const COOKIE_NAME = "fl_gate";
const MAX_AGE_MS = 12 * 3600e3; // hard cap; the cookie itself is a session cookie

async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Cookie value for a fresh unlock: "<expires ms>.<hmac>". */
export async function gateCookieValue(secret, now = Date.now()) {
  const exp = now + MAX_AGE_MS;
  return `${exp}.${await hmacHex(secret, `fl-gate:${exp}`)}`;
}

export async function gateCookieOk(request, secret, now = Date.now()) {
  const raw = request.headers.get("Cookie") || "";
  const pair = raw.split(/;\s*/).find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!pair) return false;
  const [exp, sig] = pair.slice(COOKIE_NAME.length + 1).split(".");
  if (!/^\d+$/.test(exp || "") || !sig || sig.length !== 64) return false;
  if (Number(exp) < now) return false;
  return sig === (await hmacHex(secret, `fl-gate:${exp}`));
}

/** True when the gate is on (secret set) and this request has no valid cookie. */
export async function gateLocked(request, env) {
  return Boolean(env.GATE_PASSWORD) && !(await gateCookieOk(request, env.GATE_PASSWORD));
}
