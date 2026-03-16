// TEMPORARY: Remove this entire module when bdk-wasm exposes Transaction.to_bytes() (bdk-wasm#38)
// https://github.com/bitcoindevkit/bdk-wasm/issues/38

import { Transaction } from '@scure/btc-signer'

/**
 * Extract raw consensus-encoded transaction bytes from a finalized BDK PSBT base64 string.
 * Uses @scure/btc-signer to parse the PSBT and extract the signed transaction.
 */
export function extractTxBytes(psbtBase64: string): Uint8Array {
  const psbtBytes = base64ToBytes(psbtBase64)
  const tx = Transaction.fromPSBT(psbtBytes)
  // BDK's sign() may already finalize inputs (populating finalScriptWitness
  // instead of partialSig). Try extract directly first; fall back to
  // finalize + extract for PSBTs with only partial signatures.
  try {
    return tx.extract()
  } catch {
    tx.finalize()
    return tx.extract()
  }
}

/** Broadcast a raw transaction hex to Esplora POST /tx, returns the txid.
 * Idempotent: treats "already in chain" / "already known" as success. */
export async function broadcastTransaction(
  txHex: string,
  esploraUrl: string,
): Promise<string> {
  const response = await fetch(`${esploraUrl}/tx`, {
    method: 'POST',
    body: txHex,
  })
  const body = await response.text()
  if (!response.ok) {
    // Treat already-broadcast transactions as success (idempotent)
    const lower = body.toLowerCase()
    if (
      lower.includes('transaction already in block chain') ||
      lower.includes('txn-already-known') ||
      lower.includes('txn-already-confirmed')
    ) {
      console.log('[tx-bridge] Transaction already broadcast, treating as success')
      return 'already-broadcast'
    }
    throw new Error(`Esplora broadcast failed: ${response.status} ${body}`)
  }
  return body
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
