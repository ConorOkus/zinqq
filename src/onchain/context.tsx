import { useEffect, useState, useCallback, useRef, type ReactNode } from 'react'
import {
  type Wallet,
  type EsploraClient,
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
  } catch (err) {
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

  const estimateFee = useCallback(
    async (address: string, amountSats: bigint): Promise<FeeEstimate> => {
      const wallet = walletRef.current
      const esplora = esploraRef.current
      if (!wallet || !esplora) throw new Error('Wallet not ready')

      const feeRateSatVb = await getFeeRate(esplora)
      const addr = Address.from_string(address, 'signet')
      const recipient = Recipient.from_address(addr, Amount.from_sat(amountSats))

      const txBuilder = wallet.build_tx()
      txBuilder.add_recipient(recipient)
      txBuilder.fee_rate(new FeeRate(feeRateSatVb))
      const psbt = txBuilder.finish()

      const fee = psbt.fee().to_sat()
      return { fee, feeRate: feeRateSatVb }
    },
    [],
  )

  const estimateMaxSendable = useCallback(
    async (address: string): Promise<MaxSendEstimate> => {
      const wallet = walletRef.current
      const esplora = esploraRef.current
      if (!wallet || !esplora) throw new Error('Wallet not ready')

      const feeRateSatVb = await getFeeRate(esplora)
      const addr = Address.from_string(address, 'signet')

      const txBuilder = wallet.build_tx()
      txBuilder.drain_wallet()
      txBuilder.drain_to(addr.script_pubkey)
      txBuilder.fee_rate(new FeeRate(feeRateSatVb))
      const psbt = txBuilder.finish()

      const fee = psbt.fee().to_sat()
      // Total inputs minus fee = amount sent
      const balance = wallet.balance
      const totalAvailable = balance.confirmed.to_sat() + balance.trusted_pending.to_sat()
      const amount = totalAvailable - fee

      return { amount, fee, feeRate: feeRateSatVb }
    },
    [],
  )

  const sendToAddress = useCallback(
    async (address: string, amountSats: bigint): Promise<string> => {
      const wallet = walletRef.current
      const esplora = esploraRef.current
      if (!wallet || !esplora) throw new Error('Wallet not ready')

      syncHandleRef.current?.pause()
      try {
        const feeRateSatVb = await getFeeRate(esplora)
        const addr = Address.from_string(address, 'signet')
        const recipient = Recipient.from_address(addr, Amount.from_sat(amountSats))

        const txBuilder = wallet.build_tx()
        txBuilder.add_recipient(recipient)
        txBuilder.fee_rate(new FeeRate(feeRateSatVb))
        const psbt = txBuilder.finish()

        // Fee sanity check
        const fee = psbt.fee().to_sat()
        if (fee > MAX_FEE_SATS) {
          throw new Error(`Fee too high: ${fee.toString()} sats exceeds safety limit`)
        }

        wallet.sign(psbt, new SignOptions())
        persistChangeset(wallet)

        const tx = psbt.extract_tx()
        const txid = tx.compute_txid().toString()
        await esplora.broadcast(tx)

        return txid
      } catch (err) {
        throw mapSendError(err)
      } finally {
        syncHandleRef.current?.resume()
      }
    },
    [],
  )

  const sendMax = useCallback(
    async (address: string): Promise<string> => {
      const wallet = walletRef.current
      const esplora = esploraRef.current
      if (!wallet || !esplora) throw new Error('Wallet not ready')

      syncHandleRef.current?.pause()
      try {
        const feeRateSatVb = await getFeeRate(esplora)
        const addr = Address.from_string(address, 'signet')

        const txBuilder = wallet.build_tx()
        txBuilder.drain_wallet()
        txBuilder.drain_to(addr.script_pubkey)
        txBuilder.fee_rate(new FeeRate(feeRateSatVb))
        const psbt = txBuilder.finish()

        const fee = psbt.fee().to_sat()
        if (fee > MAX_FEE_SATS) {
          throw new Error(`Fee too high: ${fee.toString()} sats exceeds safety limit`)
        }

        wallet.sign(psbt, new SignOptions())
        persistChangeset(wallet)

        const tx = psbt.extract_tx()
        const txid = tx.compute_txid().toString()
        await esplora.broadcast(tx)

        return txid
      } catch (err) {
        throw mapSendError(err)
      } finally {
        syncHandleRef.current?.resume()
      }
    },
    [],
  )

  useEffect(() => {
    let cancelled = false

    initializeBdkWallet(bdkDescriptors, 'signet')
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
              wallet,
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
          wallet: null,
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
