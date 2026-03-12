import { describe, it, expect } from 'vitest'
import { parsePeerAddress } from './peer-connection'

describe('parsePeerAddress', () => {
  it('parses valid pubkey@host:port', () => {
    const pubkey = '02' + 'a'.repeat(64)
    const result = parsePeerAddress(`${pubkey}@127.0.0.1:9735`)
    expect(result.pubkey).toBe(pubkey)
    expect(result.host).toBe('127.0.0.1')
    expect(result.port).toBe(9735)
  })

  it('handles hostname with port', () => {
    const pubkey = '03' + 'b'.repeat(64)
    const result = parsePeerAddress(`${pubkey}@node.example.com:9735`)
    expect(result.host).toBe('node.example.com')
    expect(result.port).toBe(9735)
  })

  it('handles IPv6 with port', () => {
    const pubkey = '02' + 'c'.repeat(64)
    const result = parsePeerAddress(`${pubkey}@::1:9735`)
    expect(result.host).toBe('::1')
    expect(result.port).toBe(9735)
  })

  it('throws on missing @', () => {
    expect(() => parsePeerAddress('not-a-valid-address')).toThrow('expected pubkey@host:port')
  })

  it('throws on missing port', () => {
    const pubkey = '02' + 'a'.repeat(64)
    expect(() => parsePeerAddress(`${pubkey}@127.0.0.1`)).toThrow('expected host:port')
  })

  it('throws on invalid port', () => {
    const pubkey = '02' + 'a'.repeat(64)
    expect(() => parsePeerAddress(`${pubkey}@127.0.0.1:abc`)).toThrow('port must be a number')
  })

  it('throws on port out of range', () => {
    const pubkey = '02' + 'a'.repeat(64)
    expect(() => parsePeerAddress(`${pubkey}@127.0.0.1:99999`)).toThrow('port must be a number')
  })

  it('throws on wrong pubkey length', () => {
    expect(() => parsePeerAddress('02abcd@127.0.0.1:9735')).toThrow('66 hex characters')
  })
})
