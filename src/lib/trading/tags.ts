/**
 * Each order this browser places carries a random 64-bit tag, chosen here
 * and sent with the order. The tape publishes a fill's tag the same way it
 * publishes price and size; nobody else can link a tag back to a person, but
 * this browser can recognise its own fill on the public tape by the tag it
 * already holds locally.
 */
export function generateClientTag(randomBytes: () => Uint8Array = defaultRandomBytes): string {
  const bytes = randomBytes();
  if (bytes.length !== 8) {
    throw new Error("A client tag needs exactly 8 random bytes (64 bits)");
  }
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function defaultRandomBytes(): Uint8Array {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function isOwnTag(tag: string | null | undefined, ownTags: ReadonlySet<string>): boolean {
  if (!tag) return false;
  return ownTags.has(tag);
}
