import { useEffect, useState, useCallback, useRef, type ReactNode } from 'react'
import {
  type Wallet,
  type EsploraClient,
  type Psbt,
  Address,
  Amount,
  Recipient,
  FeeRate,
  SignOptions,
  InsufficientFunds,
} from '@bitcoindevkit/bdk-wallet-web'
import {
  OnchainContext,
  defaultOnchainContextValue,
  type OnchainContextValue,
  type FeeEstimate,
  type MaxSendEstimate,
} from './onchain-context'
import { fullScanBdkWallet } from './init'
import { ONCHAIN_CONFIG } from './config'
import { ACTIVE_NETWORK } from '../ldk/config'
import { startOnchainSyncLoop, type OnchainBalance, type OnchainSyncHandle } from './sync'
import { putChangeset } from './storage/changeset'
import { useLdk } from '../ldk/use-ldk'
import type { SyncNeededCallback } from '../ldk/traits/event-handler'

const FEE_TARGET_BLOCKS = 6
const DEFAULT_FEE_RATE_SAT_VB = ACTIVE_NETWORK === 'mainnet' ? 4n : 1n
const MIN_FEE_RATE_SAT_VB = ACTIVE_NETWORK === 'mainnet' ? 2n : 1n
const MAX_FEE_SATS = 50_000n

async function getFeeRate(esploraClient: EsploraClient): Promise<bigint> {
  try {
    const estimates = await esploraClient.get_fee_estimates()
    const satPerVb = estimates.get(FEE_TARGET_BLOCKS)
    if (satPerVb !== undefined && satPerVb > 0) {
      return BigInt(Math.ceil(satPerVb))
    }
  } catch (err: unknown) {
    console.warn('[Onchain] Fee estimation failed, using default:', err)
  }
  return DEFAULT_FEE_RATE_SAT_VB
}

function persistChangeset(wallet: Wallet): void {
  const staged = wallet.take_staged()
  if (staged && !staged.is_empty()) {
    void putChangeset(staged.to_json()).catch((err: unknown) =>
      console.error('[Onchain] CRITICAL: failed to persist changeset:', err)
    )
  }
}

function discardStagedChanges(wallet: Wallet): void {
  wallet.take_staged()
}

function mapSendError(err: unknown): Error {
  if (err instanceof InsufficientFunds) {
    return new Error(
      `Insufficient funds. Available: ${err.available.to_sat().toString()} sats, needed: ${err.needed.to_sat().toString()} sats`
    )
  }
  if (err instanceof Error) {
    const msg = err.message.toLowerCase()
    if (msg.includes('network') || msg.includes('validation')) {
      return new Error('This address is for a different Bitcoin network')
    }
    if (msg.includes('dust')) {
      return new Error('Amount is below the minimum (294 sats)')
    }
    return err
  }
  return new Error(String(err))
}

export function OnchainProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<OnchainContextValue>(defaultOnchainContextValue)
  const walletRef = useRef<Wallet | null>(null)
  const esploraRef = useRef<EsploraClient | null>(null)
  const syncHandleRef = useRef<OnchainSyncHandle | null>(null)
  const ldk = useLdk()

  // Hold stable refs to LDK-provided values so the main init effect doesn't
  // re-run on every LDK state change (sync status, channel counter, etc.).
  // The bdkWallet and bdkEsploraClient are set once during LDK init and never change.
  const bdkWalletRef = useRef<Wallet | null>(null)
  const bdkEsploraRef = useRef<EsploraClient | null>(null)
  const setSyncNeededRef = useRef<((cb: SyncNeededCallback | undefined) => void) | null>(null)

  useEffect(() => {
    if (ldk.status !== 'ready') return
    bdkWalletRef.current = ldk.bdkWallet
    bdkEsploraRef.current = ldk.bdkEsploraClient
    setSyncNeededRef.current = ldk.setSyncNeeded
  }, [ldk])

  // Stable syncNow callback that delegates to the sync handle.
  // Exposed via context so the LDK layer can trigger immediate BDK sync after channel close.
  const syncNow = useCallback(() => {
    syncHandleRef.current?.syncNow()
  }, [])

  // Register syncNow with LDK when both are ready
  useEffect(() => {
    if (!setSyncNeededRef.current) return
    if (syncHandleRef.current) {
      setSyncNeededRef.current(syncNow)
    }
    return () => {
      setSyncNeededRef.current?.(undefined)
    }
  }, [ldk.status, syncNow])

  const listTransactions = useCallback(() => {
    const wallet = walletRef.current
    if (!wallet) return []
    return wallet.transactions().map((wtx) => {
      const sr = wallet.sent_and_received(wtx.tx)
      const anchor = wtx.anchors[0]
      return {
        txid: wtx.txid.toString(),
        sent: sr[0].to_sat(),
        received: sr[1].to_sat(),
        confirmationTime: anchor?.confirmation_time ?? null,
        firstSeen: wtx.first_seen ?? null,
        isConfirmed: wtx.chain_position.is_confirmed,
      }
    })
  }, [])

  const generateAddress = useCallback((): string => {
    if (!walletRef.current) throw new Error('BDK wallet not initialized')
    const info = walletRef.current.next_unused_address('external')
    return info.address.toString()
  }, [])

  /**
   * Shared helper: build a PSBT via callback, get the fee, then discard
   * staged changes. Used by estimateFee and estimateMaxSendable.
   */
  const buildAndEstimate = useCallback(
    async (
      buildPsbt: (feeRate: FeeRate) => Psbt
    ): Promise<{ psbt: Psbt; fee: bigint; feeRate: bigint }> => {
      const wallet = walletRef.current
      const esplora = esploraRef.current
      if (!wallet || !esplora) throw new Error('Wallet not ready')

      const feeRateSatVb = await getFeeRate(esplora)
      const psbt = buildPsbt(new FeeRate(feeRateSatVb))
      const fee = psbt.fee().to_sat()

      // Discard staged changes from the estimate build
      discardStagedChanges(wallet)

      return { psbt, fee, feeRate: feeRateSatVb }
    },
    []
  )

  /**
   * Shared helper: pause sync, build a PSBT via callback, apply fee sanity
   * check, sign, extract tx, broadcast, persist changeset, resume sync.
   * Used by sendToAddress and sendMax.
   */
  const buildSignBroadcast = useCallback(
    async (buildPsbt: (feeRate: FeeRate) => Psbt, feeRateSatVb?: bigint): Promise<string> => {
      const wallet = walletRef.current
      const esplora = esploraRef.current
      if (!wallet || !esplora) throw new Error('Wallet not ready')

      syncHandleRef.current?.pause()
      try {
        const resolvedFeeRate = feeRateSatVb ?? (await getFeeRate(esplora))
        if (resolvedFeeRate < MIN_FEE_RATE_SAT_VB) {
          throw new Error(
            `Fee rate ${resolvedFeeRate.toString()} sat/vB is below minimum for ${ACTIVE_NETWORK}`
          )
        }
        const psbt = buildPsbt(new FeeRate(resolvedFeeRate))

        // Fee sanity check
        const fee = psbt.fee().to_sat()
        if (fee > MAX_FEE_SATS) {
          discardStagedChanges(wallet)
          throw new Error(`Fee too high: ${fee.toString()} sats exceeds safety limit`)
        }

        wallet.sign(psbt, new SignOptions())

        const tx = psbt.extract_tx()
        const txid = tx.compute_txid().toString()
        await esplora.broadcast(tx)

        // Read balance BEFORE take_staged() to ensure the wallet still
        // knows about the just-built transaction.
        const b = wallet.balance
        setState((prev) =>
          prev.status === 'ready'
            ? {
                ...prev,
                balance: {
                  confirmed: b.confirmed.to_sat(),
                  trustedPending: b.trusted_pending.to_sat(),
                  untrustedPending: b.untrusted_pending.to_sat(),
                },
              }
            : prev
        )

        persistChangeset(wallet)

        // Trigger a sync so the balance updates once Esplora sees
        // the broadcast tx in the mempool.
        syncHandleRef.current?.syncNow()

        return txid
      } catch (err: unknown) {
        throw mapSendError(err)
      } finally {
        syncHandleRef.current?.resume()
      }
    },
    []
  )

  const estimateFee = useCallback(
    async (address: string, amountSats: bigint): Promise<FeeEstimate> => {
      const wallet = walletRef.current
      if (!wallet) throw new Error('Wallet not ready')

      const addr = Address.from_string(address, ONCHAIN_CONFIG.network)
      const { fee, feeRate } = await buildAndEstimate((feeRate) =>
        // TxBuilder methods consume self — must chain calls
        wallet
          .build_tx()
          .add_recipient(Recipient.from_address(addr, Amount.from_sat(amountSats)))
          .fee_rate(feeRate)
          .finish()
      )

      return { fee, feeRate }
    },
    [buildAndEstimate]
  )

  const estimateMaxSendable = useCallback(
    async (address: string): Promise<MaxSendEstimate> => {
      const wallet = walletRef.current
      if (!wallet) throw new Error('Wallet not ready')

      const addr = Address.from_string(address, ONCHAIN_CONFIG.network)
      const { fee, feeRate } = await buildAndEstimate((feeRate) =>
        // TxBuilder methods consume self — must chain calls
        wallet.build_tx().drain_wallet().drain_to(addr.script_pubkey).fee_rate(feeRate).finish()
      )

      // Total inputs minus fee = amount sent
      const balance = wallet.balance
      const totalAvailable = balance.confirmed.to_sat() + balance.trusted_pending.to_sat()
      const amount = totalAvailable - fee

      return { amount, fee, feeRate }
    },
    [buildAndEstimate]
  )

  const sendToAddress = useCallback(
    async (address: string, amountSats: bigint, feeRateSatVb?: bigint): Promise<string> => {
      const wallet = walletRef.current
      if (!wallet) throw new Error('Wallet not ready')

      const addr = Address.from_string(address, ONCHAIN_CONFIG.network)
      return buildSignBroadcast(
        (feeRate) =>
          // TxBuilder methods consume self — must chain calls
          wallet
            .build_tx()
            .add_recipient(Recipient.from_address(addr, Amount.from_sat(amountSats)))
            .fee_rate(feeRate)
            .finish(),
        feeRateSatVb
      )
    },
    [buildSignBroadcast]
  )

  const sendMax = useCallback(
    async (address: string, feeRateSatVb?: bigint): Promise<string> => {
      const wallet = walletRef.current
      if (!wallet) throw new Error('Wallet not ready')

      const addr = Address.from_string(address, ONCHAIN_CONFIG.network)
      return buildSignBroadcast(
        (feeRate) =>
          // TxBuilder methods consume self — must chain calls
          wallet.build_tx().drain_wallet().drain_to(addr.script_pubkey).fee_rate(feeRate).finish(),
        feeRateSatVb
      )
    },
    [buildSignBroadcast]
  )

  // Track whether LDK has become ready so the init effect runs once.
  // Using ldk.status as a dep (not the full ldk object) prevents teardown churn.
  const ldkReady = ldk.status === 'ready'

  useEffect(() => {
    const wallet = bdkWalletRef.current
    const esploraClient = bdkEsploraRef.current
    if (!ldkReady || !wallet || !esploraClient) return

    let cancelled = false

    walletRef.current = wallet
    esploraRef.current = esploraClient

    // Run full scan on the wallet that was eagerly created during LDK init
    fullScanBdkWallet(wallet, esploraClient)
      .then(() => {
        if (cancelled) return

        const handle = startOnchainSyncLoop(wallet, esploraClient, (balance: OnchainBalance) => {
          if (cancelled) return
          setState({
            status: 'ready',
            balance,
            listTransactions,
            generateAddress,
            estimateFee,
            estimateMaxSendable,
            sendToAddress,
            sendMax,
            syncNow,
            error: null,
          })
        })
        syncHandleRef.current = handle

        // Register syncNow with LDK now that the sync loop is running
        setSyncNeededRef.current?.(syncNow)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setState({
          status: 'error',
          balance: null,
          error: err instanceof Error ? err : new Error(String(err)),
        })
      })

    return () => {
      cancelled = true
      syncHandleRef.current?.stop()
      syncHandleRef.current = null
      walletRef.current = null
      esploraRef.current = null
    }
  }, [
    ldkReady,
    listTransactions,
    generateAddress,
    estimateFee,
    estimateMaxSendable,
    sendToAddress,
    sendMax,
    syncNow,
  ])

  return <OnchainContext value={state}>{children}</OnchainContext>
}
