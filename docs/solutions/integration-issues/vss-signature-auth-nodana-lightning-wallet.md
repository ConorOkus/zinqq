---
title: 'VSS requests fail with 401 Unauthorized against Nodana server due to missing signature auth'
category: integration-issues
date: 2026-04-01
tags:
  - vss
  - authentication
  - ecdsa
  - nodana
  - ldk
  - secp256k1
  - key-derivation
components:
  - src/ldk/storage/vss-client.ts
  - src/wallet/keys.ts
  - src/ldk/context.tsx
  - src/wallet/context.tsx
  - src/pages/Restore.tsx
severity: medium
related_prs:
  - '#76'
---

## Problem

The zinq Lightning wallet uses a Nodana-hosted VSS (Versioned Storage Service) server for persisting channel state. The server requires proof-of-private-key-knowledge via an ECDSA signature in the `Authorization` header. The app was constructing its `VssClient` with a `FixedHeaderProvider` using empty headers, so every VSS request returned 401 Unauthorized.

## Root Cause

The previous VSS server did not require authentication. Switching to the Nodana server introduced the VSS Signature Authorizer protocol, which requires every request to carry an `Authorization` header containing: hex-encoded compressed pubkey (66 chars) + hex-encoded compact ECDSA signature (128 chars) + Unix timestamp string.

## Solution

### 1. Dedicated Signing Key Derivation

A purpose-specific signing key is derived at BIP32 path `m/535'/2'`, following the existing derivation pattern (`m/535'/0'` for LDK seed, `m/535'/1'` for VSS encryption):

```typescript
const VSS_SIGNING_KEY_PATH = "m/535'/2'"

export function deriveVssSigningKey(mnemonic: string): Uint8Array {
  const seed = mnemonicToSeedSync(mnemonic)
  const master = HDKey.fromMasterSeed(seed)
  const child = master.derive(VSS_SIGNING_KEY_PATH)
  if (!child.privateKey) {
    throw new Error('Failed to derive VSS signing key at ' + VSS_SIGNING_KEY_PATH)
  }
  return child.privateKey
}
```

### 2. SignatureHeaderProvider

The `SignatureHeaderProvider` implements `VssHeaderProvider` and produces the `authorization` header on each request:

```typescript
// 64-byte domain separator required by the Nodana VSS Signature Authorizer protocol.
// The trailing dots pad to exactly 64 bytes -- do not modify.
const VSS_SIGNING_CONSTANT = new TextEncoder().encode(
  'VSS Signature Authorizer Signing Salt Constant..................'
)

export class SignatureHeaderProvider implements VssHeaderProvider {
  #secretKey: Uint8Array
  #pubkeyBytes: Uint8Array

  constructor(secretKey: Uint8Array) {
    this.#secretKey = new Uint8Array(secretKey) // defensive copy
    this.#pubkeyBytes = secp256k1.getPublicKey(this.#secretKey, true) // cached
  }

  destroy(): void {
    this.#secretKey.fill(0)
  }

  async getHeaders(): Promise<Record<string, string>> {
    const timestamp = Math.floor(Date.now() / 1000).toString()
    const timestampBytes = new TextEncoder().encode(timestamp)

    const preimage = new Uint8Array(
      VSS_SIGNING_CONSTANT.length + this.#pubkeyBytes.length + timestampBytes.length
    )
    preimage.set(VSS_SIGNING_CONSTANT, 0)
    preimage.set(this.#pubkeyBytes, VSS_SIGNING_CONSTANT.length)
    preimage.set(timestampBytes, VSS_SIGNING_CONSTANT.length + this.#pubkeyBytes.length)

    const hash = sha256(preimage)
    const sigBytes = await secp256k1.signAsync(hash, this.#secretKey, {
      prehash: false,
      format: 'compact',
    })

    return {
      authorization: bytesToHex(this.#pubkeyBytes) + bytesToHex(sigBytes) + timestamp,
    }
  }
}
```

### 3. Threading Through the App

The `vssSigningKey` flows through the component tree:

- `src/wallet/context.tsx` -- derives the key from the mnemonic
- `src/wallet/wallet-context.ts` -- defines `vssSigningKey: Uint8Array` in the context type
- `src/wallet/wallet-gate.tsx` -- passes it as a prop to `LdkProvider`
- `src/ldk/context.tsx` -- constructs `new SignatureHeaderProvider(vssSigningKey)`
- `src/pages/Restore.tsx` -- same pattern for the restore flow

## Debugging Pitfalls

| Attempt                                       | Symptom                             | Fix                                                               |
| --------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------- |
| `FixedHeaderProvider({})` with no auth        | 401 Unauthorized                    | Implement `SignatureHeaderProvider`                               |
| Calling `.toCompactRawBytes()` on sign result | Runtime error: not a function       | noble/secp256k1 v3 `signAsync` returns `Uint8Array` directly      |
| Omitting `{ prehash: false }`                 | "Signature was invalid" from server | Pass `prehash: false` since the message is pre-hashed with SHA256 |
| Using `ldkSeed` directly as signing key       | Code review flagged key-reuse risk  | Derived dedicated key at `m/535'/2'`                              |

## Prevention

### @noble/secp256k1 v3 API

- `signAsync()` returns a raw `Uint8Array`, not a `Signature` object. Do not call `.toCompactRawBytes()`.
- Always pass `{ prehash: false }` when signing a message you have already hashed. The default hashes the input, causing double-hashing.
- Consult the library's TypeScript signatures before assuming the API matches v1/v2.

### Key Derivation Discipline

- Never reuse a master seed directly as a signing key. Always derive a purpose-specific child key.
- Document the derivation path alongside the code so future maintainers understand the key's scope.

### Crypto Implementation Checklist

1. Make a defensive copy of secret key bytes before storing them
2. Add a `destroy()` method to zero key material on teardown
3. Cache derived values (like compressed pubkeys) that don't change
4. Write tests that verify signatures round-trip (sign then verify)

## Related Documentation

- [VSS Remote State Recovery](vss-remote-state-recovery-full-integration.md) -- key derivation for VSS encryption and store IDs
- [VSS Dual-Write Persistence](../design-patterns/vss-dual-write-persistence-with-version-conflict-resolution.md) -- persistence patterns using VssClient
- [VSS CORS Bypass via Vite Proxy](vss-cors-bypass-vite-proxy.md) -- dev proxy setup for VSS requests
- [Vercel VSS Serverless Proxy](../infrastructure/vercel-staging-vss-serverless-proxy.md) -- production proxy forwarding to VSS backend
- [BDK Descriptor Version Bytes](bdk-descriptor-version-bytes-network-mismatch.md) -- related key derivation issue
