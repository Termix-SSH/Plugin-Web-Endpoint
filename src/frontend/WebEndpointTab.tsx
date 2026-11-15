import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
} from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { RotateCw } from "lucide-react";
import { toast } from "sonner";
import {
  onDesktop,
  openWebEndpointExternally,
  openWebEndpointView,
  requireNumericHostId,
  type WebEndpointView,
} from "./web-endpoint-api";
import { copyToClipboard, ToolbarBand } from "@termix-ssh/plugin-sdk/ui";
import {
  Button,
  ConnectionScreen,
  NativeView,
} from "@termix-ssh/plugin-sdk/ui";
import type { PluginHostRecord as Host } from "@termix-ssh/plugin-sdk/frontend";
import { opensThroughTermix } from "./endpoints";
import type { WebEndpoint } from "../shared/web-endpoint-config";

// Termix 26.11.2 draws a granted page itself (plugin API 2.8).
const GrantedView = NativeView as unknown as ComponentType<{
  grant: string;
  className?: string;
}>;

/**
 * Renders one web endpoint. The backend picks the page and hands back a
 * grant; the app draws it in a native view on the desktop and in a
 * credentialless sandboxed iframe in a browser.
 *
 * Takes the whole host plus the endpoint's ID, not the endpoint object,
 * so a tab whose endpoint was deleted while it was open (or that never matched
 * one, if the host's webUiConfig raced the tab's mount) can be detected here
 * and shown a plain "no longer exists" message instead of throwing on
 * endpoint.scheme.
 */
export function WebEndpointTab({
  host,
  endpointId,
}: {
  host: Host;
  endpointId?: string;
}) {
  const { t } = useTranslation();
  const webUiConfig = (
    host.pluginSettings as Record<string, Record<string, unknown>> | undefined
  )?.["web-endpoint"]?.webUiConfig as { endpoints?: WebEndpoint[] } | undefined;
  const endpoint = (webUiConfig?.endpoints ?? []).find(
    (candidate) => candidate.id === endpointId,
  );

  const [view, setView] = useState<WebEndpointView | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Guards two in-flight resolutions completing out of order, a
   * double-clicked Reload, or a manual reload racing the mount effect. Only
   * the most recently started resolution may apply its result.
   */
  const resolveGenerationRef = useRef(0);

  const resolve = useCallback(async () => {
    if (!endpoint) return;
    const mine = ++resolveGenerationRef.current;
    setError(null);
    try {
      if (opensThroughTermix(endpoint)) {
        throw new Error(t("hosts.webUiAccessTermixDesc"));
      }
      // Always a fresh grant: the backend closes an idle tunnel after ten
      // minutes and may bind a new port, and each grant is new, so Reload
      // always reloads.
      const next = await openWebEndpointView(
        requireNumericHostId(host.id),
        endpoint.id,
      );
      if (mine !== resolveGenerationRef.current) return;
      setView(next);
    } catch (caught) {
      if (mine !== resolveGenerationRef.current) return;
      setError(caught instanceof Error ? caught.message : String(caught));
    }
    // Depends on the endpoint's FIELDS, not the object: host.webUiConfig is
    // re-derived on every render of the host list, so a dependency on
    // `endpoint` itself would reopen the tunnel on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    host.id,
    endpoint?.id,
    endpoint?.access,
    endpoint?.scheme,
    endpoint?.port,
    endpoint?.path,
    endpoint?.ignoreCert,
    endpoint?.bindHost,
    endpoint?.localPort,
  ]);

  useEffect(() => {
    void resolve();
  }, [resolve]);

  if (!endpoint) {
    return (
      <div className="relative h-full">
        <ConnectionScreen
          status="error"
          unavailable={{ title: t("webEndpoint.notFound") }}
        />
      </div>
    );
  }

  if (error) {
    return (
      <div className="relative h-full">
        <ConnectionScreen
          status="error"
          errorDetail={error}
          onManualRetry={() => void resolve()}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <ToolbarBand className="text-xs">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => void resolve()}
          title={t("webEndpoint.reload")}
        >
          <RotateCw />
        </Button>
        <span className="truncate text-muted-foreground">
          {view?.url ?? ""}
        </span>
        <Button
          variant="ghost"
          size="xs"
          className="ml-auto"
          onClick={() => {
            if (!view) return;
            void copyToClipboard(view.url).then((ok) => {
              if (ok) toast.success(t("webEndpoint.urlCopied"));
              else toast.error(t("webEndpoint.copyFailed"));
            });
          }}
        >
          {t("webEndpoint.copyUrl")}
        </Button>
        {onDesktop() && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              void openWebEndpointExternally(host, endpoint).catch((error) =>
                toast.error(error.message),
              );
            }}
          >
            {t("webEndpoint.openIsolatedWindow")}
          </Button>
        )}
      </ToolbarBand>
      {!onDesktop() && (
        <p className="px-2 py-1 text-xs text-muted-foreground">
          {t("webEndpoint.isolationNotice")}
        </p>
      )}
      {view && (
        <GrantedView
          key={view.grant}
          grant={view.grant}
          className="h-full w-full flex-1"
        />
      )}
    </div>
  );
}
