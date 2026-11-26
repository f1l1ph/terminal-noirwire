/** Copies a signature to the clipboard on a best effort basis; a missing or refused clipboard is ignored. */
export function copySignature(signature: string) {
  try {
    void navigator.clipboard.writeText(signature).catch(() => {});
  } catch {
    // No clipboard here: the shortened signature on screen is all there is.
  }
}
