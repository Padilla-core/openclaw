import type { IncomingMessage, ServerResponse } from "node:http";
import {
  approveChannelPairingCode,
  listChannelPairingRequests,
  type PairingChannel,
} from "../pairing/pairing-store.js";
import { listPairingChannels, notifyPairingApproved } from "../channels/plugins/pairing.js";
import { loadConfig } from "../config/config.js";
import { authorizeGatewayConnect, isLocalDirectRequest, type ResolvedGatewayAuth } from "./auth.js";
import { getBearerToken } from "./http-utils.js";

const PAIRING_BASE_PATH = "/api/pairing";

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
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

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        const parsed = JSON.parse(raw);
        resolve(typeof parsed === "object" && parsed !== null ? parsed : null);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

/**
 * HTTP handler for channel pairing endpoints.
 * 
 * Endpoints:
 *   GET  /api/pairing/:channel/list     - List pending pairing requests
 *   POST /api/pairing/:channel/approve  - Approve a pairing code
 * 
 * Returns true if the request was handled.
 */
export async function handlePairingHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    trustedProxies: string[];
  },
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  
  // Only handle /api/pairing/* paths
  if (!url.pathname.startsWith(PAIRING_BASE_PATH)) {
    return false;
  }

  // Parse path: /api/pairing/:channel/:action
  const pathParts = url.pathname.slice(PAIRING_BASE_PATH.length).split("/").filter(Boolean);
  if (pathParts.length !== 2) {
    sendJson(res, 404, { ok: false, error: "Not Found" });
    return true;
  }

  const [channelRaw, action] = pathParts;
  const channel = resolveChannel(channelRaw);
  
  if (!channel) {
    sendJson(res, 400, { ok: false, error: `Invalid channel: ${channelRaw}` });
    return true;
  }

  // Authorize request (local or bearer token)
  if (!isLocalDirectRequest(req, opts.trustedProxies)) {
    const token = getBearerToken(req);
    if (!token) {
      sendJson(res, 401, { ok: false, error: "Unauthorized" });
      return true;
    }
    const authResult = await authorizeGatewayConnect({
      auth: { ...opts.auth, allowTailscale: false },
      connectAuth: { token, password: token },
      req,
      trustedProxies: opts.trustedProxies,
    });
    if (!authResult.ok) {
      sendJson(res, 401, { ok: false, error: "Unauthorized" });
      return true;
    }
  }

  // Handle list action
  if (action === "list" && req.method === "GET") {
    try {
      const requests = await listChannelPairingRequests(channel);
      sendJson(res, 200, { ok: true, channel, requests });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err) });
    }
    return true;
  }

  // Handle approve action
  if (action === "approve" && req.method === "POST") {
    const body = await readJsonBody(req);
    const code = typeof body?.code === "string" ? body.code.trim() : "";
    const notify = body?.notify === true;
    
    if (!code) {
      sendJson(res, 400, { ok: false, error: "code is required" });
      return true;
    }

    try {
      const approved = await approveChannelPairingCode({ channel, code });
      if (!approved) {
        sendJson(res, 404, { ok: false, error: `No pending pairing request found for code: ${code}` });
        return true;
      }

      // Optionally notify the requester
      if (notify) {
        const cfg = loadConfig();
        await notifyPairingApproved({ channelId: channel, id: approved.id, cfg }).catch(() => {});
      }

      sendJson(res, 200, { ok: true, channel, id: approved.id, approved: true });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err) });
    }
    return true;
  }

  // Unknown action
  sendJson(res, 404, { ok: false, error: "Not Found" });
  return true;
}
