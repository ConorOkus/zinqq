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
import { initializeBdkWallet } from './init'
import { ONCHAIN_CONFIG } from './config'
import { startOnchainSyncLoop, type OnchainBalance, type OnchainSyncHandle } from './sync'
import { putChangeset } from './storage/changeset'
import { useLdk } from '../ldk/use-ldk'

const FEE_TARGET_BLOCKS = 6
const DEFAULT_FEE_RATE_SAT_VB = 1n
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
      console.error('[Onchain] CRITICAL: failed to persist changeset:', err),
    )
  }
}

function discardStagedChanges(wallet: Wallet): void {
  wallet.take_staged()
}

function mapSendError(err: unknown): Error {
  if (err instanceof InsufficientFunds) {
    return new Error(
      `Insufficient funds. Available: ${err.available.to_sat().toString()} sats, needed: ${err.needed.to_sat().toString()} sats`,
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

export function OnchainProvider({
  children,
  bdkDescriptors,
}: {
  children: ReactNode
  bdkDescriptors: { external: string; internal: string }
}) {
  const [state, setState] = useState<OnchainContextValue>(defaultOnchainContextValue)
  const walletRef = useRef<Wallet | null>(null)
  const esploraRef = useRef<EsploraClient | null>(null)
  const syncHandleRef = useRef<OnchainSyncHandle | null>(null)
  const ldk = useLdk()

  // Hold a stable ref to setBdkWallet so it doesn't trigger effect re-runs.
  // The ldk context object changes reference on every LDK state update —
  // depending on it directly would tear down and rebuild BDK on each change.
  const setBdkWalletRef = useRef<((wallet: Wallet | null) => void) | null>(null)
  useEffect(() => {
    setBdkWalletRef.current = ldk.status === 'ready' ? ldk.setBdkWallet : null
    // If BDK wallet initialized before LDK became ready, register it now
    if (walletRef.current && setBdkWalletRef.current) {
      setBdkWalletRef.current(walletRef.current)
    }
  }, [ldk])

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
    async (buildPsbt: (feeRate: FeeRate) => Psbt): Promise<{ psbt: Psbt; fee: bigint; feeRate: bigint }> => {
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
    [],
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
        const resolvedFeeRate = feeRateSatVb ?? await getFeeRate(esplora)
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
        persistChangeset(wallet)

        return txid
      } catch (err: unknown) {
        throw mapSendError(err)
      } finally {
        syncHandleRef.current?.resume()
      }
    },
    [],
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
          .finish(),
      )

      return { fee, feeRate }
    },
    [buildAndEstimate],
  )

  const estimateMaxSendable = useCallback(
    async (address: string): Promise<MaxSendEstimate> => {
      const wallet = walletRef.current
      if (!wallet) throw new Error('Wallet not ready')

      const addr = Address.from_string(address, ONCHAIN_CONFIG.network)
      const { fee, feeRate } = await buildAndEstimate((feeRate) =>
        // TxBuilder methods consume self — must chain calls
        wallet
          .build_tx()
          .drain_wallet()
          .drain_to(addr.script_pubkey)
          .fee_rate(feeRate)
          .finish(),
      )

      // Total inputs minus fee = amount sent
      const balance = wallet.balance
      const totalAvailable = balance.confirmed.to_sat() + balance.trusted_pending.to_sat()
      const amount = totalAvailable - fee

      return { amount, fee, feeRate }
    },
    [buildAndEstimate],
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
        feeRateSatVb,
      )
    },
    [buildSignBroadcast],
  )

  const sendMax = useCallback(
    async (address: string, feeRateSatVb?: bigint): Promise<string> => {
      const wallet = walletRef.current
      if (!wallet) throw new Error('Wallet not ready')

      const addr = Address.from_string(address, ONCHAIN_CONFIG.network)
      return buildSignBroadcast(
        (feeRate) =>
          // TxBuilder methods consume self — must chain calls
          wallet
            .build_tx()
            .drain_wallet()
            .drain_to(addr.script_pubkey)
            .fee_rate(feeRate)
            .finish(),
        feeRateSatVb,
      )
    },
    [buildSignBroadcast],
  )

  useEffect(() => {
    let cancelled = false

    initializeBdkWallet(bdkDescriptors, ONCHAIN_CONFIG.network)
      .then(({ wallet, esploraClient }) => {
        if (cancelled) return

        walletRef.current = wallet
        esploraRef.current = esploraClient

        // Register BDK wallet with LDK event handler for channel funding
        setBdkWalletRef.current?.(wallet)

        const handle = startOnchainSyncLoop(
          wallet,
          esploraClient,
          (balance: OnchainBalance) => {
            if (cancelled) return
            setState({
              status: 'ready',
              balance,
              generateAddress,
              estimateFee,
              estimateMaxSendable,
              sendToAddress,
              sendMax,
              error: null,
            })
          },
        )
        syncHandleRef.current = handle
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
      // Unregister BDK wallet from LDK event handler
      setBdkWalletRef.current?.(null)
      walletRef.current = null
      esploraRef.current = null
    }
  }, [bdkDescriptors, generateAddress, estimateFee, estimateMaxSendable, sendToAddress, sendMax])

  return <OnchainContext value={state}>{children}</OnchainContext>
}
