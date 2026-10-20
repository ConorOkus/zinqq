let owner: symbol | null = null

/** One owner may select/sign on-chain inputs at a time, including channel funding. */
export function beginWalletSpend(): () => void {
  if (owner) throw new Error('Another on-chain transaction is being prepared. Try again shortly.')
  const token = Symbol()
  owner = token
  return () => {
    if (owner === token) owner = null
  }
}
export const walletSpendInProgress = () => owner !== null
