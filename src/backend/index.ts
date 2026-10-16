import type { Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { createWebEndpointRoutes } from "./routes.js";
import { createProxySessions } from "./proxy.js";
import { hostImportNormalizer } from "./host-import.js";

export async function activate(ctx: PluginContext) {
  // The proxy streams request bodies and serves a whole web app, so it needs
  // raw bodies and more than the default public request budget.
  // publicRateLimit needs SDK 1.0.8; an older core ignores it.
  const routerOptions = {
    public: ["/p/:token/*"],
    rawBody: true,
    publicRateLimit: 3000,
  };
  const router = ctx.http.router<Router>(routerOptions);
  const sessions = createProxySessions();
  ctx.disposables.add(() => sessions.clear());
  router.use(createWebEndpointRoutes(ctx, sessions));

  ctx.registry.provide(
    "web-endpoint.hostImportNormalizer",
    hostImportNormalizer,
  );
  ctx.disposables.add(
    () =>
      void ctx.registry.revoke(
        "web-endpoint.hostImportNormalizer",
        hostImportNormalizer,
      ),
  );

  ctx.log.info("Web Endpoint routes mounted at /plugin-api/web-endpoint");
}

export async function deactivate() {}
