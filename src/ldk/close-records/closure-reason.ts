import {
  type ClosureReason,
  ClosureReason_CounterpartyForceClosed,
  ClosureReason_HolderForceClosed,
  ClosureReason_LegacyCooperativeClosure,
  ClosureReason_CounterpartyInitiatedCooperativeClosure,
  ClosureReason_LocallyInitiatedCooperativeClosure,
  ClosureReason_CommitmentTxConfirmed,
  ClosureReason_FundingTimedOut,
  ClosureReason_ProcessingError,
  ClosureReason_DisconnectedPeer,
  ClosureReason_OutdatedChannelManager,
  ClosureReason_CounterpartyCoopClosedUnfundedChannel,
  ClosureReason_LocallyCoopClosedUnfundedChannel,
  ClosureReason_FundingBatchClosure,
  ClosureReason_HTLCsTimedOut,
  ClosureReason_PeerFeerateTooLow,
} from 'lightningdevkit'

export interface ClosureClassification {
  /** Human-readable description, shown in the close detail view. */
  description: string
  closeType: 'coop' | 'force' | 'unknown'
  initiator: 'local' | 'remote' | 'unknown'
  /**
   * False for reasons where no on-chain closing transaction exists
   * (unfunded/abandoned channels) — those never create a close record.
   */
  hasOnchainTx: boolean
}

/**
 * Exhaustive ClosureReason → record mapping. Exhaustiveness is enforced by
 * a unit test enumerating every `ClosureReason_*` export of the bindings
 * (LDK discriminates via instanceof subclasses, so the type system can't
 * check this). Unknown future variants default to tracking when a funding
 * outpoint is present.
 */
export function classifyClosureReason(reason: ClosureReason): ClosureClassification {
  if (reason instanceof ClosureReason_LegacyCooperativeClosure) {
    return { description: 'Cooperative close', closeType: 'coop', initiator: 'unknown', hasOnchainTx: true }
  }
  if (reason instanceof ClosureReason_LocallyInitiatedCooperativeClosure) {
    return { description: 'Cooperative close', closeType: 'coop', initiator: 'local', hasOnchainTx: true }
  }
  if (reason instanceof ClosureReason_CounterpartyInitiatedCooperativeClosure) {
    return {
      description: 'Cooperative close (initiated by peer)',
      closeType: 'coop',
      initiator: 'remote',
      hasOnchainTx: true,
    }
  }
  if (reason instanceof ClosureReason_HolderForceClosed) {
    return { description: 'Force closed by you', closeType: 'force', initiator: 'local', hasOnchainTx: true }
  }
  if (reason instanceof ClosureReason_CounterpartyForceClosed) {
    return {
      description: 'Counterparty force closed',
      closeType: 'force',
      initiator: 'remote',
      hasOnchainTx: true,
    }
  }
  if (reason instanceof ClosureReason_CommitmentTxConfirmed) {
    return {
      description: 'Commitment transaction confirmed',
      closeType: 'force',
      initiator: 'remote',
      hasOnchainTx: true,
    }
  }
  if (reason instanceof ClosureReason_HTLCsTimedOut) {
    return {
      description: 'Force closed to resolve timed-out payments',
      closeType: 'force',
      initiator: 'local',
      hasOnchainTx: true,
    }
  }
  if (reason instanceof ClosureReason_ProcessingError) {
    return { description: 'Processing error', closeType: 'force', initiator: 'local', hasOnchainTx: true }
  }
  if (reason instanceof ClosureReason_OutdatedChannelManager) {
    return {
      description: 'Outdated channel manager',
      closeType: 'force',
      initiator: 'local',
      hasOnchainTx: true,
    }
  }
  if (reason instanceof ClosureReason_PeerFeerateTooLow) {
    return { description: 'Peer feerate too low', closeType: 'force', initiator: 'local', hasOnchainTx: true }
  }
  // No on-chain close tx — channel was never funded or abandoned pre-funding.
  if (reason instanceof ClosureReason_DisconnectedPeer) {
    return { description: 'Peer disconnected', closeType: 'unknown', initiator: 'unknown', hasOnchainTx: false }
  }
  if (reason instanceof ClosureReason_FundingTimedOut) {
    return { description: 'Funding timed out', closeType: 'unknown', initiator: 'unknown', hasOnchainTx: false }
  }
  if (reason instanceof ClosureReason_CounterpartyCoopClosedUnfundedChannel) {
    return {
      description: 'Counterparty closed unfunded channel',
      closeType: 'unknown',
      initiator: 'remote',
      hasOnchainTx: false,
    }
  }
  if (reason instanceof ClosureReason_LocallyCoopClosedUnfundedChannel) {
    return {
      description: 'Closed unfunded channel',
      closeType: 'unknown',
      initiator: 'local',
      hasOnchainTx: false,
    }
  }
  if (reason instanceof ClosureReason_FundingBatchClosure) {
    return {
      description: 'Funding batch closure',
      closeType: 'unknown',
      initiator: 'unknown',
      hasOnchainTx: false,
    }
  }
  // Unknown future variant: safe default is to track when a funding txo exists.
  return { description: 'Channel closed', closeType: 'unknown', initiator: 'unknown', hasOnchainTx: true }
}
