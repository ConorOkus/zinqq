import { describe, it, expect, beforeEach } from 'vitest'
import { getSeed, storeDerivedSeed } from './seed'
import { idbDelete } from '../../storage/idb'

beforeEach(async () => {
  await idbDelete('ldk_seed', 'primary')
})

describe('seed storage', () => {
  it('returns undefined when no seed exists', async () => {
    const seed = await getSeed()
    expect(seed).toBeUndefined()
  })

  it('stores a 32-byte derived seed and retrieves it', async () => {
    const seed = new Uint8Array(32)
    crypto.getRandomValues(seed)
    await storeDerivedSeed(seed)

    const retrieved = await getSeed()
    expect(Array.from(retrieved!)).toEqual(Array.from(seed))
  })

  it('throws if a seed already exists', async () => {
    const seed = new Uint8Array(32)
    crypto.getRandomValues(seed)
    await storeDerivedSeed(seed)
    await expect(storeDerivedSeed(seed)).rejects.toThrow('Seed already exists')
  })

  it('throws if seed is not 32 bytes', async () => {
    const badSeed = new Uint8Array(16)
    await expect(storeDerivedSeed(badSeed)).rejects.toThrow('Expected 32-byte seed')
  })
})
