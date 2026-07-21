import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { ScreenHeader } from '../components/ScreenHeader'
import { formatBtc } from '../utils/format-btc'
import { useCloseRecords, useLastKnownTipHeight } from '../ldk/close-records/use-close-records'
import {
  deriveCloseStatus,
  type CloseRecordTx,
  type CloseStatus,
} from '../ldk/close-records/close-record'
import { humanizeBlocks } from '../ldk/close-records/estimate'
import { readRecoveryState, type RecoveryState } from '../ldk/recovery/recovery-state'

const EXPLORER_TX_URL = 'https://mempool.space/tx'

const STATUS_LABELS: Record<CloseStatus, string> = {
  closing: 'Closing',
  waiting_timelock: 'Waiting (timelock)',
  returning: 'Returning to wallet',
  complete: 'Complete',
  resolved_unverified: 'Resolved (unverified)',
}

const ROLE_LABELS: Record<CloseRecordTx['role'], string> = {
  closing: 'Closing transaction',
  commitment: 'Commitment transaction',
  anchor_cpfp: 'Fee bump (CPFP)',
  htlc_claim: 'Payment claim',
  sweep: 'Sweep to wallet',
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-3">
      <span className="text-[var(--color-on-dark-muted)]">{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
  )
}

function TxRow({ tx, tipHeight }: { tx: CloseRecordTx; tipHeight: number | null }) {
  const [copied, setCopied] = useState(false)
  const copy = useCallback(() => {
    navigator.clipboard
      .writeText(tx.txid)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  }, [tx.txid])

  const confirmations =
    tx.confirmedAtHeight !== undefined && tipHeight !== null
      ? Math.max(0, tipHeight - tx.confirmedAtHeight + 1)
      : null

  return (
    <div className="flex flex-col gap-1 border-b border-white/10 py-3 last:border-b-0">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">{ROLE_LABELS[tx.role]}</span>
        <span className="text-xs text-[var(--color-on-dark-muted)]">
          {tx.confirmedAtHeight === undefined
            ? 'Unconfirmed'
            : confirmations !== null
              ? `${String(confirmations)} conf${confirmations === 1 ? '' : 's'}`
              : 'Confirmed'}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <a
          href={`${EXPLORER_TX_URL}/${tx.txid}`}
          target="_blank"
          rel="noopener noreferrer"
          className="truncate font-mono text-xs text-accent underline underline-offset-2"
        >
          {tx.txid.slice(0, 10)}…{tx.txid.slice(-10)}
        </a>
        <button className="shrink-0 text-xs text-accent" onClick={copy}>
          {copied ? 'Copied' : 'Copy txid'}
        </button>
      </div>
      {tx.feeSats !== undefined && (
        <span className="text-xs text-[var(--color-on-dark-muted)]">
          Fee: {formatBtc(tx.feeSats)}
        </span>
      )}
    </div>
  )
}

export function ChannelCloseDetail() {
  const { channelId } = useParams<{ channelId: string }>()
  const records = useCloseRecords()
  const tipHeight = useLastKnownTipHeight()
  const [recovery, setRecovery] = useState<RecoveryState | null>(null)

  // Needs-deposit is derived from RecoveryState at render — never stored on
  // the record. RecoveryState remains the single writer for that flow.
  useEffect(() => {
    let cancelled = false
    const load = () => {
      readRecoveryState()
        .then((state) => {
          if (!cancelled) setRecovery(state)
        })
        .catch(() => {})
    }
    load()
    window.addEventListener('zinqq:recovery-state-changed', load)
    return () => {
      cancelled = true
      window.removeEventListener('zinqq:recovery-state-changed', load)
    }
  }, [])

  const record = records.find((r) => r.channelId === channelId)

  if (!record) {
    return (
      <div className="flex min-h-dvh flex-col bg-dark text-on-dark">
        <ScreenHeader title="Channel Close" backTo="/activity" />
        <div className="flex flex-1 items-center justify-center">
          <p className="text-[var(--color-on-dark-muted)]">Close record not found</p>
        </div>
      </div>
    )
  }

  const status = deriveCloseStatus(record, tipHeight)
  const needsDeposit =
    recovery?.status === 'needs_recovery' && recovery.channelIds.includes(record.channelId)
  const blocksRemaining =
    record.claimableAtHeight !== undefined && tipHeight !== null
      ? Math.max(0, record.claimableAtHeight - tipHeight)
      : null
  const totalFeesSats = record.txs.reduce((sum, tx) => sum + (tx.feeSats ?? 0n), 0n)
  const isTerminal = status === 'complete' || status === 'resolved_unverified'

  return (
    <div className="flex min-h-dvh flex-col bg-dark text-on-dark">
      <ScreenHeader title="Channel Close" backTo="/activity" />

      <div className="flex flex-col items-center gap-2 px-6 pb-6 pt-8">
        <span className="text-lg font-semibold text-[var(--color-on-dark-muted)]">
          {STATUS_LABELS[status]}
        </span>
        <div className="font-display text-4xl font-bold">
          {record.expectedAmountSats !== undefined
            ? `${isTerminal ? '' : '~'}${formatBtc(record.expectedAmountSats)}`
            : '—'}
        </div>
        {!isTerminal && (
          <p className="text-center text-sm text-[var(--color-on-dark-muted)]">
            {record.initiator === 'remote'
              ? 'This channel was closed by the network. Your funds are safe and return to your wallet automatically.'
              : 'Your funds return to your wallet automatically.'}
            {blocksRemaining !== null && blocksRemaining > 0 && (
              <>
                {' '}
                Accessible in {humanizeBlocks(blocksRemaining)} ({String(blocksRemaining)} blocks).
              </>
            )}
          </p>
        )}
        {status === 'resolved_unverified' && (
          <p className="text-center text-sm text-amber-400">
            The close resolved on-chain, but this wallet couldn&apos;t verify receiving the funds —
            they may have been swept on another device.
          </p>
        )}
      </div>

      {needsDeposit && (
        <Link
          to="/recover"
          className="mx-6 mb-4 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-400"
        >
          A small deposit is needed to recover these funds — tap to continue.
        </Link>
      )}

      <div className="mx-6 border-t border-white/10" />

      <div className="flex flex-col px-6 pt-2">
        <DetailRow label="Initiated" value={formatDate(record.createdAt)} />
        {record.closureReason && <DetailRow label="Reason" value={record.closureReason} />}
        <DetailRow
          label="Close type"
          value={
            record.closeType === 'coop'
              ? 'Cooperative'
              : record.closeType === 'force'
                ? 'Force close'
                : 'Unknown'
          }
        />
        {isTerminal && totalFeesSats > 0n && (
          <DetailRow label="Total fees paid" value={formatBtc(totalFeesSats)} />
        )}
        {record.completedAt !== undefined && (
          <DetailRow label="Completed" value={formatDate(record.completedAt)} />
        )}
      </div>

      {record.txs.length > 0 && (
        <div className="flex flex-col px-6 pt-4">
          <span className="text-sm font-medium text-[var(--color-on-dark-muted)]">
            Transactions
          </span>
          <div className="flex flex-col">
            {record.txs.map((tx) => (
              <TxRow key={tx.txid} tx={tx} tipHeight={tipHeight} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
