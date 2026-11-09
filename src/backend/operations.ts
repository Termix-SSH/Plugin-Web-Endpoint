import type {
  PluginContext,
  PluginOperationContext,
} from "@termix-ssh/plugin-sdk/backend";
import {
  parseWebUiConfig,
  type WebEndpoint,
} from "../shared/web-endpoint-config.js";

function requireHost(context: PluginOperationContext): number {
  if (context.hostId === undefined) throw new Error("This needs a host");
  return context.hostId;
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\''`)}'`;
}

/** curl on the host itself, so it works for direct and tunnel endpoints. */
export function checkCommand(endpoint: WebEndpoint): string {
  const path = endpoint.path?.startsWith("/") ? endpoint.path : "/";
  const url = `${endpoint.scheme}://127.0.0.1:${endpoint.port}${path}`;
  return `command -v curl >/dev/null || { echo nocurl; exit 0; }; curl -sk -o /dev/null --max-time 10 -w '%{http_code}' ${quote(url)} || echo 000`;
}

/** Endpoints of a host that do not answer, as acting user over SSH. */
export async function downEndpoints(
  ctx: PluginContext,
  hostId: number,
): Promise<WebEndpoint[]> {
  const config = parseWebUiConfig(
    await ctx.settings.getHost(hostId, "webUiConfig"),
  );
  const down: WebEndpoint[] = [];
  for (const endpoint of config.endpoints) {
    const result = await ctx.ssh.exec(hostId, checkCommand(endpoint), {
      purpose: "web-endpoint-check",
      timeoutMs: 20000,
    });
    const code = result.stdout.trim();
    if (code !== "nocurl" && !/^[1-4]\d\d$/.test(code)) down.push(endpoint);
  }
  return down;
}

/** Web endpoints as actions: list them and check that each one answers. */
export function registerOperations(ctx: PluginContext): void {
  if (typeof ctx.operations?.register !== "function") return;

  const endpointsOf = async (hostId: number) =>
    parseWebUiConfig(await ctx.settings.getHost(hostId, "webUiConfig"))
      .endpoints;

  ctx.operations.register("web-endpoint.check", {
    run: async (_input, context) => {
      const hostId = requireHost(context);
      const endpoints = await endpointsOf(hostId);
      if (endpoints.length === 0) {
        return {
          summary: "No web endpoints",
          data: { rows: [], status: "unknown", label: "None" },
        };
      }
      const rows = [];
      for (const endpoint of endpoints) {
        const result = await ctx.ssh.exec(hostId, checkCommand(endpoint), {
          purpose: "web-endpoint-check",
          timeoutMs: 20000,
        });
        const code = result.stdout.trim();
        rows.push({
          id: endpoint.id,
          name: endpoint.label,
          port: endpoint.port,
          answer: code === "nocurl" ? "curl missing" : code,
          up: /^[1-4]\d\d$/.test(code),
        });
      }
      const down = rows.filter((row) => !row.up);
      const label = down.length
        ? `${down.map((row) => row.name).join(", ")} down`
        : `${rows.length} up`;
      return {
        summary: label,
        data: { rows, status: down.length ? "fail" : "ok", label },
      };
    },
  });
}
