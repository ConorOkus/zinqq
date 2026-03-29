/**
 * LSPS2 protocol client.
 *
 * Implements the two-step LSPS2 flow: get_info -> buy.
 * All protocol logic is async; the sync/async bridge is in message-handler.ts.
 */

import { hexToBytes } from '../utils'
import type { JsonRpcResponse } from './types'
import {
  type OpeningFeeParams,
  type BuyResponse,
  serializeJsonRpcRequest,
  serializeOpeningFeeParams,
  deserializeOpeningFeeParams,
  lsps2ErrorMessage,
} from './types'
import { encodeBolt11Invoice, parseLsps2Scid, type RouteHintEntry } from './bolt11-encoder'

type SendRequestFn = (peerPubkey: Uint8Array, payload: string) => Promise<JsonRpcResponse>

export class LSPS2Client {
  private sendRequest: SendRequestFn

  constructor(sendRequest: SendRequestFn) {
    this.sendRequest = sendRequest
  }

  async getOpeningFeeParams(lspNodeId: string, token?: string): Promise<OpeningFeeParams[]> {
    const params: Record<string, unknown> = { token: token ?? null }

    const response = await this.sendLsps2Request(lspNodeId, 'lsps2.get_info', params)

    if (response.error) {
      throw new Error(lsps2ErrorMessage(response.error.code))
    }

    const result = response.result as Record<string, unknown> | undefined
    if (!result || !Array.isArray(result.opening_fee_params_menu)) {
      throw new Error('Invalid lsps2.get_info response: missing opening_fee_params_menu')
    }

    return (result.opening_fee_params_menu as unknown[]).map((raw) =>
      deserializeOpeningFeeParams(raw as Parameters<typeof deserializeOpeningFeeParams>[0])
    )
  }

  async buyChannel(
    lspNodeId: string,
    feeParams: OpeningFeeParams,
    paymentSizeMsat: bigint
  ): Promise<BuyResponse> {
    const params: Record<string, unknown> = {
      opening_fee_params: serializeOpeningFeeParams(feeParams),
      payment_size_msat: paymentSizeMsat.toString(),
    }

    const response = await this.sendLsps2Request(lspNodeId, 'lsps2.buy', params)

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

    if (trustsLsp !== false) {
      throw new Error(
        'This LSP requires a trust mode that is not supported. ' +
          'Your funds would not be protected until the channel is confirmed.'
      )
    }

    return {
      jitChannelScid: scid,
      lspCltvExpiryDelta: cltvDelta,
    }
  }

  /**
   * Create a BOLT11 invoice with a route hint through the LSP for a JIT channel.
   *
   * Uses channelManager.create_inbound_payment() to register the payment with LDK,
   * then builds and signs the BOLT11 invoice manually with custom route hints.
   */
  async createJitInvoice(params: {
    buyResponse: BuyResponse
    lspNodeId: string
    amountMsat: bigint
    description: string
    nodeId: Uint8Array // 33-byte compressed pubkey
    nodeSecretKey: Uint8Array // 32-byte secret
    paymentHash: Uint8Array // 32 bytes from create_inbound_payment
    paymentSecret: Uint8Array // 32 bytes from create_inbound_payment
    minFinalCltvExpiry: number
  }): Promise<string> {
    const lspPubkey = hexToBytes(params.lspNodeId)
    const scidU64 = parseLsps2Scid(params.buyResponse.jitChannelScid)

    const routeHint: RouteHintEntry = {
      pubkey: lspPubkey,
      shortChannelId: scidU64,
      feeBaseMsat: 0,
      feeProportionalMillionths: 0,
      cltvExpiryDelta: params.buyResponse.lspCltvExpiryDelta,
    }

    return await encodeBolt11Invoice(
      {
        amountMsat: params.amountMsat,
        paymentHash: params.paymentHash,
        paymentSecret: params.paymentSecret,
        description: params.description,
        expirySecs: 3600, // 1 hour
        // bLIP-52: add +2 to min_final_cltv_expiry to account for blocks mined during payment
        minFinalCltvExpiry: params.minFinalCltvExpiry + 2,
        payeeNodeId: params.nodeId,
        routeHints: [[routeHint]],
      },
      params.nodeSecretKey
    )
  }

  private async sendLsps2Request(
    lspNodeId: string,
    method: string,
    params: Record<string, unknown>
  ): Promise<JsonRpcResponse> {
    const id = crypto.randomUUID()
    const payload = serializeJsonRpcRequest(id, method, params)
    const pubkeyBytes = hexToBytes(lspNodeId)
    return this.sendRequest(pubkeyBytes, payload)
  }
}
