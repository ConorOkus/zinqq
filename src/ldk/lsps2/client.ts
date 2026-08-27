/**
 * LSPS2 protocol client.
 *
 * Mirrors LDK's `LSPS2ClientHandler`: `requestOpeningParams` (lsps2.get_info)
 * and `selectOpeningParams` (lsps2.buy). It returns the invoice parameters
 * (intercept SCID + CLTV delta); building the BOLT11 invoice from them is an
 * app-layer concern (see `executeJitBuy` in context.tsx), matching LDK, where
 * the handler surfaces `InvoiceParametersReady` and the caller builds the invoice.
 * All protocol logic is async; the sync/async bridge is in message-handler.ts.
 */

import { hexToBytes } from '../utils'
import { captureError } from '../../storage/error-log'
import type { JsonRpcResponse } from './types'
import {
  type LSPS2OpeningFeeParams,
  type LSPS2InvoiceParameters,
  serializeJsonRpcRequest,
  serializeOpeningFeeParams,
  deserializeOpeningFeeParams,
  lsps2ErrorMessage,
} from './types'

type SendRequestFn = (peerPubkey: Uint8Array, payload: string) => Promise<JsonRpcResponse>

export class LSPS2Client {
  private sendRequest: SendRequestFn

  constructor(sendRequest: SendRequestFn) {
    this.sendRequest = sendRequest
  }

  async requestOpeningParams(
    counterpartyNodeId: string,
    token: string | null
  ): Promise<LSPS2OpeningFeeParams[]> {
    const params: Record<string, unknown> = { token }

    const response = await this.sendLsps2Request(counterpartyNodeId, 'lsps2.get_info', params)

    if (response.error) {
      captureError('error', 'LSPS2', 'get_info error', JSON.stringify(response.error))
      throw new Error(lsps2ErrorMessage(response.error.code))
    }

    const result = response.result as Record<string, unknown> | undefined
    if (!result || !Array.isArray(result.opening_fee_params_menu)) {
      throw new Error('Invalid lsps2.get_info response: missing opening_fee_params_menu')
    }

    const feeParamsMenu = (result.opening_fee_params_menu as unknown[]).map((raw) =>
      deserializeOpeningFeeParams(raw as Parameters<typeof deserializeOpeningFeeParams>[0])
    )

    for (const fp of feeParamsMenu) {
      console.log('[LSPS2] min_payment_size_msat:', fp.minPaymentSizeMsat.toString())
    }

    return feeParamsMenu
  }

  async selectOpeningParams(
    counterpartyNodeId: string,
    paymentSizeMsat: bigint,
    openingFeeParams: LSPS2OpeningFeeParams
  ): Promise<LSPS2InvoiceParameters> {
    const params: Record<string, unknown> = {
      opening_fee_params: serializeOpeningFeeParams(openingFeeParams),
      payment_size_msat: paymentSizeMsat.toString(),
    }

    const response = await this.sendLsps2Request(counterpartyNodeId, 'lsps2.buy', params)

    if (response.error) {
      throw new Error(lsps2ErrorMessage(response.error.code))
    }

    const result = response.result as Record<string, unknown> | undefined
    if (!result) throw new Error('Invalid lsps2.buy response: missing result')

    const scid = result.jit_channel_scid
    const cltvDelta = result.lsp_cltv_expiry_delta
    const trustsLsp = result.client_trusts_lsp

    if (typeof scid !== 'string' || !scid) {
      throw new Error('Invalid lsps2.buy response: missing or invalid jit_channel_scid')
    }
    if (typeof cltvDelta !== 'number' || !Number.isFinite(cltvDelta) || cltvDelta < 1) {
      throw new Error('Invalid lsps2.buy response: invalid lsp_cltv_expiry_delta')
    }

    return {
      interceptScid: scid,
      cltvExpiryDelta: cltvDelta,
      clientTrustsLsp: trustsLsp === true,
    }
  }

  private async sendLsps2Request(
    lspNodeId: string,
    method: string,
    params: Record<string, unknown>
  ): Promise<JsonRpcResponse> {
    const id = crypto.randomUUID()
    const payload = serializeJsonRpcRequest(id, method, params)
    // Only rewrite `token` when the request actually carries one (lsps2.get_info).
    // Unconditionally adding it made lsps2.buy — which takes no token per spec —
    // log `"token":null`, reading as if the token had been dropped.
    const logParams =
      'token' in params ? { ...params, token: params.token ? '[REDACTED]' : null } : params
    console.log('[LSPS2] Sending:', method, JSON.stringify(logParams))
    const pubkeyBytes = hexToBytes(lspNodeId)
    return this.sendRequest(pubkeyBytes, payload)
  }
}
