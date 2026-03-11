import { describe, it, expect, beforeEach } from 'vitest'
import { getSeed, generateAndStoreSeed } from './seed'
import { idbDelete } from './idb'

beforeEach(async () => {
  // Clear seed between tests
  await idbDelete('ldk_seed', 'primary')
})

describe('seed storage', () => {
  it('returns undefined when no seed exists', async () => {
    const seed = await getSeed()
    expect(seed).toBeUndefined()
  })

  it('generates a 32-byte seed and persists it', async () => {
    const seed = await generateAndStoreSeed()
    expect(seed).toBeInstanceOf(Uint8Array)
    expect(seed.length).toBe(32)

    const retrieved = await getSeed()
    expect(Array.from(retrieved!)).toEqual(Array.from(seed))
  })

  it('throws if a seed already exists', async () => {
    await generateAndStoreSeed()
    await expect(generateAndStoreSeed()).rejects.toThrow('Seed already exists')
  })

  it('generates different seeds across calls', async () => {
    const seed1 = await generateAndStoreSeed()

    // Clear seed to allow generating another
    await idbDelete('ldk_seed', 'primary')
    const seed2 = await generateAndStoreSeed()

    // Extremely unlikely to be equal with crypto.getRandomValues
    expect(seed1).not.toEqual(seed2)
  })
})
