import { useState } from "react";
import { ExternalLink, Globe } from "lucide-react";
import {
  useHosts,
  useSettings,
  useTabs,
  useTranslation,
  type CompanionDefaults,
  type CompanionProps,
  type DashboardCardProps,
  type PluginHostRecord,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  ListRow,
  ListRowAction,
  PanelList,
  Select2,
} from "@termix-ssh/plugin-sdk/ui";
import type { WebEndpoint } from "../shared/web-endpoint-config";
import { endpointsOf, openEndpoint } from "./endpoints";
import { WebEndpointTab } from "./WebEndpointTab";

/** Endpoints that can show inside Termix, not only in a browser. */
export function embeddedEndpointsOf(host: PluginHostRecord): WebEndpoint[] {
  return endpointsOf(host).filter((endpoint) => endpoint.render !== "external");
}

/** Whether the web panel beside this host's terminal is on. */
export function webPanelEnabled(
  host: PluginHostRecord | null | undefined,
): boolean {
  if (!host) return false;
  const settings = (
    host.pluginSettings as Record<string, Record<string, unknown>> | undefined
  )?.["web-endpoint"];
  return settings?.showPanel !== false && embeddedEndpointsOf(host).length > 0;
}

/** Starting state of the panel, from the user's settings. */
export function useWebCompanionDefaults(): CompanionDefaults {
  const { values } = useSettings("user");
  const side = values.companionSide;
  return {
    open: values.companionAutoOpen === true,
    side: side === "left" || side === "bottom" ? side : "right",
    size: typeof values.companionSize === "number" ? values.companionSize : 520,
    edgeButton: values.companionEdgeButton !== false,
  };
}

/** The host's web UI beside its terminal, with a picker for several. */
export function WebEndpointCompanion({ host }: CompanionProps) {
  const { t } = useTranslation();
  const tabs = useTabs();
  const endpoints = host ? embeddedEndpointsOf(host) : [];
  const [picked, setPicked] = useState<string>("");
  const endpoint =
    endpoints.find((candidate) => candidate.id === picked) ?? endpoints[0];
  if (!host || !endpoint) {
    return (
      <p className="p-2 text-xs text-muted-foreground">
        {t("webEndpoint.notFound")}
      </p>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-border p-1.5">
        {endpoints.length > 1 ? (
          <Select2
            value={endpoint.id}
            onChange={(e) => setPicked(e.target.value)}
            className="h-7 min-w-0 flex-1 border border-border bg-background px-2 text-xs"
          >
            {endpoints.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.label}
              </option>
            ))}
          </Select2>
        ) : (
          <span className="min-w-0 flex-1 truncate px-1 text-xs text-muted-foreground">
            {endpoint.label}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => openEndpoint(host, endpoint, tabs)}
          title={t("companion.openTab")}
        >
          <ExternalLink className="size-3.5" />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">
        <WebEndpointTab
          key={endpoint.id}
          host={host}
          endpointId={endpoint.id}
        />
      </div>
    </div>
  );
}

/** Dashboard card: every web UI on the user's hosts, one click to open. */
export function WebEndpointsCard({ shell }: DashboardCardProps) {
  const { t } = useTranslation();
  const { hosts } = useHosts();
  const rows = hosts.flatMap((host) =>
    endpointsOf(host).map((endpoint) => ({ host, endpoint })),
  );
  return (
    <PanelList
      empty={
        <p className="p-3 text-xs text-muted-foreground">{t("card.empty")}</p>
      }
    >
      {rows.map(({ host, endpoint }, index) => (
        <ListRow
          key={`${host.id}:${endpoint.id}`}
          stripe={index}
          icon={<Globe className="size-3.5" />}
          title={endpoint.label}
          meta={`${host.name || host.ip} | ${endpoint.scheme}://:${endpoint.port}${endpoint.path ?? ""}`}
          onClick={() => openEndpoint(host, endpoint, shell)}
          actions={
            <ListRowAction
              label={t("card.open")}
              tone="brand"
              onClick={() => openEndpoint(host, endpoint, shell)}
            >
              <ExternalLink />
            </ListRowAction>
          }
        />
      ))}
    </PanelList>
  );
}
