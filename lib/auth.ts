// Passphrase auth: cookie holds sha256(NOVA_PASSPHRASE). Works in Edge + Node.
export const COOKIE = "nova_session";

export async function token(pass = process.env.NOVA_PASSPHRASE ?? "") {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("nova:" + pass));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function isAuthed(cookie?: string) {
  return !!process.env.NOVA_PASSPHRASE && !!cookie && cookie === (await token());
}
