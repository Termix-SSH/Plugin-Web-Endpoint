import i18next from "i18next";
import { toast } from "sonner";
import type {
  PluginHostRecord,
  ShellApi,
} from "@termix-ssh/plugin-sdk/frontend";
import type { WebEndpoint } from "../shared/web-endpoint-config";
import { openWebEndpointExternally } from "./web-endpoint-api";

export const TAB_TYPE = "web-endpoint";

export function webEndpointSettings(host: PluginHostRecord): {
  enableWebUi: boolean;
  webUiConfig: { endpoints: WebEndpoint[] };
} {
  const settings = (
    host.pluginSettings as Record<string, Record<string, unknown>> | undefined
  )?.["web-endpoint"];
  return {
    enableWebUi: settings?.enableWebUi === true,
    webUiConfig: (settings?.webUiConfig as
      { endpoints: WebEndpoint[] } | undefined) ?? {
      endpoints: [],
    },
  };
}

export function endpointsOf(host: PluginHostRecord): WebEndpoint[] {
  const { enableWebUi, webUiConfig } = webEndpointSettings(host);
  if (!enableWebUi) return [];
  return webUiConfig.endpoints ?? [];
}

export function openEndpoint(
  host: PluginHostRecord,
  endpoint: WebEndpoint,
  shell: Pick<ShellApi, "openTab">,
): void {
  if (endpoint.render === "external") {
    // No tab at all: the real browser opens it. On the desktop the plugin
    // asks the backend to open it in an isolated window.
    openWebEndpointExternally(
      host as unknown as { id: string; ip: string },
      endpoint,
    ).catch((error: unknown) => {
      toast.error(
        error instanceof Error
          ? error.message
          : i18next.t("web-endpoint:hosts.webUiOpenFailed"),
      );
    });
    return;
  }
  shell.openTab(host, TAB_TYPE, {
    label: endpoint.label,
    data: { endpointId: endpoint.id },
  });
}
