import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";

export type TunnelPreference = "unset" | "quick" | "named";

export interface TunnelState {
  workspaceId: string;
  preference: TunnelPreference;
  askedAt?: string;
  provider?: "cloudflare-quick" | "cloudflare-named";
  tunnelName?: string;
  tunnelId?: string;
  hostname?: string;
  zone?: string;
  configuredAt?: string;
  fallbackReason?: string;
}

export function tunnelStateFile(workspaceId: string): string {
  return path.join(getStateDir(), "tunnels", `${workspaceId}.json`);
}

export function readTunnelState(workspaceId: string): TunnelState {
  return (
    readJsonIfExists<TunnelState>(tunnelStateFile(workspaceId)) ?? {
      workspaceId,
      preference: "unset",
    }
  );
}

export function writeTunnelState(state: TunnelState): TunnelState {
  writeSecureJson(tunnelStateFile(state.workspaceId), state);
  return state;
}

export function needsTunnelChoice(state: TunnelState): boolean {
  return state.preference === "unset" || !state.askedAt;
}

export function isNamedTunnelReady(state: TunnelState): boolean {
  return (
    state.preference === "named" &&
    Boolean(state.tunnelName?.trim()) &&
    Boolean(state.hostname?.trim())
  );
}

export function namedTunnelBinding(state: TunnelState): { tunnelName: string; hostname: string } | null {
  if (!isNamedTunnelReady(state) || !state.tunnelName || !state.hostname) return null;
  return { tunnelName: state.tunnelName, hostname: state.hostname };
}

export const TUNNEL_CHOICE_PROMPT = `Before connecting ChatGPT, choose an optional connection type.
Do you have a Cloudflare account and a domain already managed by Cloudflare?
- Yes: use a stable hostname. Configure the plugin once; computer restarts normally do not require plugin changes. Log in to Cloudflare once and add a subdomain under your domain.
- No: use a temporary address. No registration is required and features are the same. The address can change after a restart, invalidating the old ChatGPT connection. I will recreate this project's plugin with the new address; you may need to log in to ChatGPT again. Recovery is supported but takes longer.
An account is not required. Which option do you prefer? If you have a domain, enter it (for example, example.com).`;

export const NAMED_LOGIN_PROMPT =
  "A browser will open. Log in to Cloudflare, select your domain, then tell me done.";

export const NAMED_FALLBACK_MESSAGE =
  "Using a temporary address for now. Features are the same, but connection repair may take longer. Ask to switch to a stable hostname whenever you prefer.";

export const NAMED_REPAIR_MESSAGE =
  "The stable hostname is unavailable. In the browser window, log in to Cloudflare, select your domain, then tell me done.";
