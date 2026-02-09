import type { GatewayRequestHandlers } from "./types.js";
import { loadConfig } from "../../config/config.js";
import { listPairingChannels, notifyPairingApproved } from "../../channels/plugins/pairing.js";
import {
  approveChannelPairingCode,
  listChannelPairingRequests,
  type PairingChannel,
} from "../../pairing/pairing-store.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";

function validateChannelPairListParams(
  params: unknown,
): params is { channel: string } {
  if (!params || typeof params !== "object") {
    return false;
  }
  const p = params as Record<string, unknown>;
  return typeof p.channel === "string" && p.channel.trim().length > 0;
}

function validateChannelPairApproveParams(
  params: unknown,
): params is { channel: string; code: string; notify?: boolean } {
  if (!params || typeof params !== "object") {
    return false;
  }
  const p = params as Record<string, unknown>;
  return (
    typeof p.channel === "string" &&
    p.channel.trim().length > 0 &&
    typeof p.code === "string" &&
    p.code.trim().length > 0
  );
}

function resolveChannel(raw: string): PairingChannel | null {
  const value = raw.trim().toLowerCase();
  const channels = listPairingChannels();
  if (channels.includes(value as PairingChannel)) {
    return value as PairingChannel;
  }
  // Allow extension channels with valid format
  if (/^[a-z][a-z0-9_-]{0,63}$/.test(value)) {
    return value as PairingChannel;
  }
  return null;
}

export const channelPairingHandlers: GatewayRequestHandlers = {
  "channel.pair.list": async ({ params, respond }) => {
    if (!validateChannelPairListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "invalid channel.pair.list params: channel (string) required",
        ),
      );
      return;
    }
    const channel = resolveChannel(params.channel);
    if (!channel) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `invalid channel: ${params.channel}`),
      );
      return;
    }
    try {
      const requests = await listChannelPairingRequests(channel);
      respond(true, { channel, requests }, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, String(err)),
      );
    }
  },

  "channel.pair.approve": async ({ params, respond, context }) => {
    if (!validateChannelPairApproveParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "invalid channel.pair.approve params: channel (string) and code (string) required",
        ),
      );
      return;
    }
    const channel = resolveChannel(params.channel);
    if (!channel) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `invalid channel: ${params.channel}`),
      );
      return;
    }
    try {
      const approved = await approveChannelPairingCode({
        channel,
        code: params.code,
      });
      if (!approved) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `no pending pairing request found for code: ${params.code}`),
        );
        return;
      }

      context.logGateway.info(
        `channel pairing approved channel=${channel} id=${approved.id}`,
      );

      context.broadcast(
        "channel.pair.resolved",
        {
          channel,
          id: approved.id,
          decision: "approved",
          ts: Date.now(),
        },
        { dropIfSlow: true },
      );

      // Optionally notify the requester
      if (params.notify) {
        const cfg = loadConfig();
        await notifyPairingApproved({ channelId: channel, id: approved.id, cfg }).catch((err) => {
          context.logGateway.warn(`failed to notify pairing requester: ${String(err)}`);
        });
      }

      respond(true, { channel, id: approved.id, approved: true }, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, String(err)),
      );
    }
  },
};
