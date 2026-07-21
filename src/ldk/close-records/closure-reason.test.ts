import { describe, it, expect, vi } from 'vitest'
// Raw source imports: the installed bindings' declaration file is the ground
// truth for which ClosureReason variants exist; the classifier source is
// scanned for instanceof coverage of each.
// eslint-disable-next-line import/no-unresolved
import bindingsSource from 'lightningdevkit/structs/ClosureReason.d.mts?raw'
// eslint-disable-next-line import/no-unresolved
import classifierSource from './closure-reason.ts?raw'

vi.mock('lightningdevkit', () => {
  const names = [
    'ClosureReason_CounterpartyForceClosed',
    'ClosureReason_HolderForceClosed',
    'ClosureReason_LegacyCooperativeClosure',
    'ClosureReason_CounterpartyInitiatedCooperativeClosure',
    'ClosureReason_LocallyInitiatedCooperativeClosure',
    'ClosureReason_CommitmentTxConfirmed',
    'ClosureReason_FundingTimedOut',
    'ClosureReason_ProcessingError',
    'ClosureReason_DisconnectedPeer',
    'ClosureReason_OutdatedChannelManager',
    'ClosureReason_CounterpartyCoopClosedUnfundedChannel',
    'ClosureReason_LocallyCoopClosedUnfundedChannel',
    'ClosureReason_FundingBatchClosure',
    'ClosureReason_HTLCsTimedOut',
    'ClosureReason_PeerFeerateTooLow',
  ]
  const exports: Record<string, unknown> = {}
  for (const name of names) {
    exports[name] = class {
      static mockName = name
    }
  }
  return exports
})

import * as mockedLdk from 'lightningdevkit'
import { classifyClosureReason } from './closure-reason'

/**
 * Exhaustiveness is test-enforced, not type-enforced: LDK discriminates
 * ClosureReason via instanceof subclasses. This test reads the INSTALLED
 * bindings' declaration file, so upgrading LDK with a new variant fails CI
 * until the classifier (and this file's mock) learn about it.
 */
describe('classifyClosureReason exhaustiveness', () => {
  const bindingVariants = [
    ...new Set(
      [...bindingsSource.matchAll(/class (ClosureReason_\w+)/g)].map((m) => m[1] as string)
    ),
  ]

  it('the installed bindings expose the variants this suite knows about', () => {
    expect(bindingVariants.length).toBeGreaterThanOrEqual(15)
  })

  it.each(bindingVariants)('%s is handled by the classifier', (variant) => {
    expect(classifierSource).toContain(`reason instanceof ${variant}`)
  })

  it.each(bindingVariants)('%s classifies to a non-default result', (variant) => {
    const Ctor = (mockedLdk as unknown as Record<string, new () => unknown>)[variant]
    if (!Ctor) {
      // A variant added by a future LDK upgrade: the source-scan test above
      // already failed; this keeps the mock list in sync too.
      throw new Error(`Mock missing for ${variant} — add it to this test's vi.mock list`)
    }
    const result = classifyClosureReason(new Ctor() as never)
    // The fallback default is { description: 'Channel closed', ... } — every
    // known variant must classify more specifically.
    expect(result.description).not.toBe('Channel closed')
  })

  it('unknown future variants fall back to tracking when a funding txo exists', () => {
    const result = classifyClosureReason({} as never)
    expect(result).toEqual({
      description: 'Channel closed',
      closeType: 'unknown',
      initiator: 'unknown',
      hasOnchainTx: true,
    })
  })

  it('no-tx variants never create records; force/coop variants do', () => {
    const noTx = [
      'ClosureReason_DisconnectedPeer',
      'ClosureReason_FundingTimedOut',
      'ClosureReason_CounterpartyCoopClosedUnfundedChannel',
      'ClosureReason_LocallyCoopClosedUnfundedChannel',
      'ClosureReason_FundingBatchClosure',
    ]
    for (const variant of bindingVariants) {
      const Ctor = (mockedLdk as unknown as Record<string, new () => unknown>)[variant]
      if (!Ctor) throw new Error(`Mock missing for ${variant}`)
      const result = classifyClosureReason(new Ctor() as never)
      expect(result.hasOnchainTx).toBe(!noTx.includes(variant))
    }
  })
})
