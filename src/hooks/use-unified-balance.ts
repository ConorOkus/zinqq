import { useOnchain } from '../onchain/use-onchain'
import { useLdk } from '../ldk/use-ldk'

export interface UnifiedBalance {
  total: bigint
  onchain: bigint
  lightning: bigint
  pending: bigint
  isLoading: boolean
}

export function useUnifiedBalance(): UnifiedBalance {
  const onchain = useOnchain()
  const ldk = useLdk()

  const isLoading = onchain.status === 'loading' || ldk.status === 'loading'

  const onchainBalance =
    onchain.status === 'ready'
      ? onchain.balance.confirmed + onchain.balance.trustedPending
      : 0n

  const lightningBalance =
    ldk.status === 'ready' ? ldk.lightningBalanceSats : 0n

  const pending =
    onchain.status === 'ready' ? onchain.balance.untrustedPending : 0n

  return {
    total: onchainBalance + lightningBalance,
    onchain: onchainBalance,
    lightning: lightningBalance,
    pending,
    isLoading,
  }
}
