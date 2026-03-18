export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Convert a Bitcoin txid/block-hash from LDK's internal byte order to display
 * order (reversed). LDK stores these as raw SHA256d hashes; Esplora and block
 * explorers use the reversed hex representation.
 */
export function txidBytesToHex(bytes: Uint8Array): string {
  const reversed = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) {
    reversed[i] = bytes[bytes.length - 1 - i]!
  }
  return bytesToHex(reversed)
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Hex string must have even length')
  if (!/^[0-9a-f]*$/.test(hex)) throw new Error('Invalid hex characters')
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16)
  }
  return bytes
}
