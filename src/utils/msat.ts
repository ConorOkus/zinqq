/** Convert millisatoshis to satoshis using floor division (never overstates). */
export function msatToSatFloor(msat: bigint): bigint {
  return msat / 1000n
}
