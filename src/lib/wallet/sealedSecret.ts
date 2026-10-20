/**
 * Passphrase encryption for the one secret this terminal keeps: the owner
 * key. The same scheme the shared NoirWire wallet keystore uses: AES-256-GCM
 * under a PBKDF2-SHA256 key, WebCrypto only, no dependency. The derived key
 * is not extractable; the stored copy is worthless without the passphrase.
 * The owner key itself has to be raw bytes in memory to sign, so the goal
 * is ciphertext at rest and plaintext only while the wallet is unlocked.
 */

const ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

/** What is written to storage. `publicKey` is bound into the ciphertext, so it cannot be relabelled. */
export interface SealedSecret {
  v: 1;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  publicKey: string;
  salt: string;
  iv: string;
  ciphertext: string;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

/** One passphrase typed as different bytes (a composed accent, a full-width letter) opens the same wallet. */
function passphraseBytes(passphrase: string): Uint8Array {
  return new TextEncoder().encode(passphrase.normalize("NFKC"));
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number) {
  const material = await crypto.subtle.importKey(
    "raw",
    passphraseBytes(passphrase) as BufferSource,
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function additionalData(publicKey: string): BufferSource {
  return new TextEncoder().encode(publicKey) as BufferSource;
}

export async function sealSecret(
  publicKey: string,
  secret: Uint8Array,
  passphrase: string,
): Promise<SealedSecret> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt, ITERATIONS);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource, additionalData: additionalData(publicKey) },
    key,
    secret as BufferSource,
  );
  return {
    v: 1,
    kdf: "PBKDF2-SHA256",
    iterations: ITERATIONS,
    publicKey,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
  };
}

/** The secret, or null for a wrong passphrase (GCM's tag detects it; it never yields wrong bytes). */
export async function openSecret(
  sealed: SealedSecret,
  passphrase: string,
): Promise<Uint8Array | null> {
  try {
    const key = await deriveKey(passphrase, fromBase64(sealed.salt), sealed.iterations);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64(sealed.iv) as BufferSource,
        additionalData: additionalData(sealed.publicKey),
      },
      key,
      fromBase64(sealed.ciphertext) as BufferSource,
    );
    return new Uint8Array(plaintext);
  } catch {
    return null;
  }
}

/**
 * Null for anything this build did not write itself. The iteration count
 * must be exactly this build's: a smaller one stored by someone else would
 * weaken the passphrase, and a huge one would hang every unlock.
 */
export function parseSealedSecret(raw: string | null): SealedSecret | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<SealedSecret>;
    const valid =
      value.v === 1 &&
      value.kdf === "PBKDF2-SHA256" &&
      value.iterations === ITERATIONS &&
      typeof value.publicKey === "string" &&
      typeof value.salt === "string" &&
      typeof value.iv === "string" &&
      typeof value.ciphertext === "string";
    return valid ? (value as SealedSecret) : null;
  } catch {
    return null;
  }
}
