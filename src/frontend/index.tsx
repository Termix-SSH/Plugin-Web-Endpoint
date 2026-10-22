import { Globe } from "lucide-react";
import type {
  HostEditorSectionProps,
  TabProps,
  TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import type { PluginHostRecord as Host } from "@termix-ssh/plugin-sdk/frontend";
import { WebEndpointTab } from "./WebEndpointTab";
import { HostEditorWebUiSection } from "./HostEditorWebUiSection";
import { setWebEndpointApi } from "./web-endpoint-api";
import { TAB_TYPE, endpointsOf, openEndpoint } from "./endpoints";
import {
  WebEndpointCompanion,
  WebEndpointsCard,
  useWebCompanionDefaults,
  webPanelEnabled,
} from "./WebEndpointCompanion";

function EndpointTab({ host, tab }: TabProps) {
  // Resolved against the host on every render, so an endpoint deleted while
  // its tab is open shows a plain message instead of throwing.
  const endpointId = tab.data?.endpointId;
  return (
    <WebEndpointTab
      host={host as unknown as Host}
      endpointId={typeof endpointId === "string" ? endpointId : undefined}
    />
  );
}

function WebUiSection(props: HostEditorSectionProps) {
  return <HostEditorWebUiSection {...props} />;
}

export function activate(app: TermixApp): void {
  setWebEndpointApi(app.api);
  app.onDispose(() => setWebEndpointApi(null));

  app.registerTab(TAB_TYPE, EndpointTab, {
    icon: Globe,
    titleKey: "hosts.tabWebUi",
    requiresHost: true,
    noHostMessageKey: "webEndpoint.noHostSelected",
    // A restored tab could never hold a valid URL: the backend closes an idle
    // tunnel after ten minutes and binds a fresh port on the next open. So
    // these tabs are session-only and never saved.
    persistent: false,
    inLayouts: false,
  });

  // One entry per host, not one per endpoint: with several it opens a picker.
  // Gated on enableWebUi alone, since a direct endpoint needs no SSH.
  app.registerHostAction({
    id: TAB_TYPE,
    titleKey: "hosts.tabWebUi",
    icon: Globe,
    kind: "open",
    order: 80,
    when: (host) => endpointsOf(host).length > 0,
    label: (host) => {
      const endpoints = endpointsOf(host);
      return endpoints.length === 1 ? endpoints[0].label : undefined;
    },
    items: (host) =>
      endpointsOf(host).map((endpoint) => ({
        id: endpoint.id,
        label: endpoint.label,
        run: (target, shell) => openEndpoint(target, endpoint, shell),
      })),
  });

  app.registerHostEditorSection({
    id: "web-ui",
    group: "ssh",
    titleKey: "hosts.tabWebUi",
    icon: Globe,
    order: 40,
    component: WebUiSection,
  });

  app.registerDashboardCard({
    id: "web-endpoints",
    titleKey: "card.title",
    defaultPanel: "side",
    defaultHeight: 200,
    frame: "framed",
    component: WebEndpointsCard,
  });

  // Cores before 26.10.3 have no panels beside tabs.
  if (typeof app.registerCompanion === "function") {
    app.registerCompanion("web", WebEndpointCompanion, {
      icon: Globe,
      titleKey: "hosts.tabWebUi",
      order: 110,
      tabTypes: ["terminal"],
      when: (_tab, host) => webPanelEnabled(host),
      useDefaults: useWebCompanionDefaults,
    });
    app.registerAction("web-endpoint.togglePanel", ((
      _handle: unknown,
      tab: unknown,
    ) => app.toggleCompanion(tab as never, "web")) as never);
    app.registerSlotContribution("tab.menu", {
      actionId: "web-endpoint.togglePanel",
      titleKey: "companion.toggle",
      icon: Globe,
      kind: "button",
      order: 14,
      when: (context) => {
        const tab = context.tab as {
          type?: string;
          host?: unknown;
          hostConfig?: unknown;
        } | null;
        return (
          tab?.type === "terminal" &&
          webPanelEnabled((tab.host ?? tab.hostConfig) as never)
        );
      },
    });
  }
}
