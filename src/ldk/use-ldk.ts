import { useContext } from 'react'
import { LdkContext, type LdkContextValue } from './ldk-context'

export function useLdk(): LdkContextValue {
  return useContext(LdkContext)
}
