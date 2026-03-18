import { chacha20poly1305 } from '@noble/ciphers/chacha.js'

const NONCE_LENGTH = 12
const KEY_LENGTH = 32

function assertKeyLength(key: Uint8Array): void {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`[VSS Crypto] Key must be exactly ${KEY_LENGTH} bytes, got ${key.length}`)
  }
}

/**
 * Encrypt plaintext using ChaCha20-Poly1305 with a random 12-byte nonce.
 * Returns [12-byte nonce][ciphertext+tag].
 */
export function vssEncrypt(key: Uint8Array, plaintext: Uint8Array): Uint8Array {
  assertKeyLength(key)
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH))
  const cipher = chacha20poly1305(key, nonce)
  const ciphertext = cipher.encrypt(plaintext)

  // Prepend nonce to ciphertext: [nonce (12 bytes)][ciphertext + auth tag]
  const result = new Uint8Array(NONCE_LENGTH + ciphertext.length)
  result.set(nonce, 0)
  result.set(ciphertext, NONCE_LENGTH)
  return result
}

/**
 * Decrypt a blob produced by vssEncrypt. Splits off the 12-byte nonce prefix,
 * then decrypts with ChaCha20-Poly1305.
 */
export function vssDecrypt(key: Uint8Array, cipherBlob: Uint8Array): Uint8Array {
  assertKeyLength(key)
  if (cipherBlob.length < NONCE_LENGTH + 16) {
    throw new Error('[VSS Crypto] Cipher blob too short to contain nonce + auth tag')
  }
  const nonce = cipherBlob.slice(0, NONCE_LENGTH)
  const ciphertext = cipherBlob.slice(NONCE_LENGTH)
  const cipher = chacha20poly1305(key, nonce)
  return cipher.decrypt(ciphertext)
}

/**
 * Obfuscate a plaintext key using HMAC-SHA256 with the encryption key.
 * Returns a deterministic hex string suitable for use as a VSS storage key.
 */
export async function obfuscateKey(
  encryptionKey: Uint8Array,
  plaintextKey: string,
): Promise<string> {
  // Copy to guarantee a fresh ArrayBuffer (avoids TypedArray view aliasing)
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(encryptionKey).buffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const data = new TextEncoder().encode(plaintextKey)
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, data)
  const hashArray = new Uint8Array(signature)
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
