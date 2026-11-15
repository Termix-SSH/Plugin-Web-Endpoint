import axios from "axios";
import i18next from "i18next";
import type { PluginApiClient } from "@termix-ssh/plugin-sdk/frontend";
import { isElectron } from "@termix-ssh/plugin-sdk/ui";
import type { WebEndpoint } from "../shared/web-endpoint-config";

let pluginApi: PluginApiClient | null = null;
let desktop: { readonly available: boolean } | null = null;

/** This plugin's string, or the key itself when i18next is not set up. */
function message(key: string): string {
  const text = i18next.t(`web-endpoint:${key}`);
  return typeof text === "string" && text ? text : key;
}

function genericFailure(error: unknown, key: string): never {
  if (!axios.isAxiosError(error) && error instanceof Error) throw error;
  const status = axios.isAxiosError(error) ? error.response?.status : undefined;
  throw new WebEndpointTunnelError(message(key), status);
}

/** Set from activate with app.api, cleared on deactivate. */
export function setWebEndpointApi(api: PluginApiClient | null): void {
  pluginApi = api;
}

/** Set from activate with app.desktop, which also works in a frame. */
export function setWebEndpointDesktop(
  next: { readonly available: boolean } | null,
): void {
  desktop = next;
}

/** True in the desktop app. */
export function onDesktop(): boolean {
  return desktop ? desktop.available : isElectron();
}

/** A page the backend picked for a tab, and the address to show. */
export interface WebEndpointView {
  grant: string;
  url: string;
}

/**
 * Asks the backend to pick the page for a tab. It hands back a grant the
 * app draws the page from; the tab can't change the address.
 */
export async function openWebEndpointView(
  hostId: number,
  endpointId: string,
): Promise<WebEndpointView> {
  if (!pluginApi) throw new Error(message("errors.notActive"));
  try {
    const { data } = await pluginApi.post<Partial<WebEndpointView>>("/view", {
      hostId,
      endpointId,
    });
    if (typeof data?.grant !== "string" || typeof data.url !== "string") {
      throw new Error(message("errors.openTunnelFailed"));
    }
    return { grant: data.grant, url: data.url };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const data = error.response?.data as
        { error?: unknown; code?: unknown } | undefined;
      if (data?.code === "direct-shares-session-cookie") {
        throw new Error(message("webEndpoint.directSharesSessionCookie"));
      }
      if (typeof data?.error === "string" && data.error) {
        throw new WebEndpointTunnelError(data.error, error.response?.status);
      }
    }
    return genericFailure(error, "errors.openTunnelFailed");
  }
}

/**
 * Thrown when the backend rejects a web endpoint tunnel open with a specific,
 * actionable reason, most commonly a 502 carrying the real cause: SSH auth
 * rejected, host unreachable, or nothing listening on the target port.
 * Preserves that reason instead of collapsing three actionable errors into
 * one generic failure.
 */
export class WebEndpointTunnelError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "WebEndpointTunnelError";
  }
}

/** The one time address that opens an endpoint through this server. */
export async function openWebEndpointThroughTermix(
  hostId: number,
  endpointId: string,
): Promise<string> {
  if (!pluginApi) throw new Error(message("errors.notActive"));
  try {
    const response = await pluginApi.post("/open-termix", {
      hostId,
      endpointId,
    });
    return (response.data as { url: string }).url;
  } catch (error) {
    const reason = (error as { response?: { data?: { error?: unknown } } })
      ?.response?.data?.error;
    if (typeof reason === "string" && reason) throw new Error(reason);
    throw error;
  }
}

/**
 * A web endpoint tunnel opens through the backend's numeric host id.
 * Quick-connect hosts (ids like "quick-connect-<n>") have no row on the
 * server, so there is nothing to open a tunnel through, unlike a direct
 * endpoint, which never touches the backend and works regardless.
 */
export function requireNumericHostId(id: string): number {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    throw new Error(message("errors.savedHostRequired"));
  }
  return numericId;
}

/**
 * Desktop windows use a dedicated ephemeral session, including login popups.
 *
 * The backend resolves and validates the target URL (the host's own declared
 * address for a direct endpoint, or the tunnel port it opens for a tunnel
 * one) and opens the window itself through ctx.desktop.openIsolatedWindow, so
 * the capability check and audit line cover the whole decision, this call
 * only asks for it and reports whether it worked.
 */
export async function openWebEndpointExternally(
  host: { id: string; ip: string },
  endpoint: WebEndpoint,
): Promise<void> {
  if (!onDesktop()) {
    throw new Error(message("errors.desktopOnly"));
  }
  if (!pluginApi) throw new Error(message("errors.notActive"));
  try {
    await pluginApi.post("/open-window", {
      hostId: requireNumericHostId(host.id),
      endpointId: endpoint.id,
      ignoreCert: endpoint.ignoreCert === true,
    });
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const data = error.response?.data as
        { error?: unknown; message?: unknown } | undefined;
      const backendMessage = data?.error ?? data?.message;
      if (typeof backendMessage === "string" && backendMessage) {
        throw new WebEndpointTunnelError(
          backendMessage,
          error.response?.status,
        );
      }
    }
    return genericFailure(error, "errors.openWindowFailed");
  }
}
