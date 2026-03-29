/**
 * LSPS2 protocol client.
 *
 * Implements the two-step LSPS2 flow: get_info -> buy.
 * All protocol logic is async; the sync/async bridge is in message-handler.ts.
 */

import { hexToBytes } from '../utils'
import type { LspsMessageHandlerResult } from './message-handler'
import {
  type OpeningFeeParams,
  type BuyResponse,
  type JsonRpcResponse,
  serializeJsonRpcRequest,
  serializeOpeningFeeParams,
  deserializeOpeningFeeParams,
  calculateOpeningFee,
  selectCheapestParams,
  lsps2ErrorMessage,
} from './types'
import { encodeBolt11Invoice, parseLsps2Scid, type RouteHintEntry } from './bolt11-encoder'

export class LSPS2Client {
  private messageHandler: LspsMessageHandlerResult

  constructor(messageHandler: LspsMessageHandlerResult) {
    this.messageHandler = messageHandler
  }

  async getOpeningFeeParams(lspNodeId: string, token?: string): Promise<OpeningFeeParams[]> {
    const params: Record<string, unknown> = {}
    if (token) params.token = token

    const response = await this.sendLsps2Request(lspNodeId, 'lsps2.get_info', params)

    if (response.error) {
      throw new Error(lsps2ErrorMessage(response.error.code))
    }

    const result = response.result as { opening_fee_params_menu: unknown[] }
    if (!result?.opening_fee_params_menu || !Array.isArray(result.opening_fee_params_menu)) {
      throw new Error('Invalid lsps2.get_info response: missing opening_fee_params_menu')
    }

    return result.opening_fee_params_menu.map((raw) =>
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

    const result = response.result as {
      jit_channel_scid: string
      lsp_cltv_expiry_delta: number
      client_trusts_lsp: boolean
    }

    if (!result?.jit_channel_scid) {
      throw new Error('Invalid lsps2.buy response: missing jit_channel_scid')
    }

    if (result.client_trusts_lsp) {
      throw new Error(
        'This LSP requires a trust mode that is not supported. ' +
          'Your funds would not be protected until the channel is confirmed.'
      )
    }

    return {
      jitChannelScid: result.jit_channel_scid,
      lspCltvExpiryDelta: result.lsp_cltv_expiry_delta,
      clientTrustsLsp: result.client_trusts_lsp,
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
    return this.messageHandler.sendRequest(pubkeyBytes, payload)
  }
}
