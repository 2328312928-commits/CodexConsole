import type { FastifyBaseLogger } from 'fastify';
import { setupUrl } from './auth/setupLink.js';
import type { BridgeLogger } from './codex/bridge.js';
import type { AppConfig } from './config.js';
import { buildApp } from './http/app.js';
import { buildPublicApi } from './http/publicApi.js';
import { createRuntime } from './runtime.js';

export interface RunningConsole {
  log: FastifyBaseLogger;
  ownerExists(): boolean;
  /** True while a setup link made earlier still works. */
  hasSetupLink(): boolean;
  /** A new one-time setup link (older ones stop working); null once setup is finished. */
  newSetupLink(): string | null;
  close(): Promise<void>;
}

/** Start Codex, the console and (when enabled) the public API. */
export async function startConsole(config: AppConfig, opts: { logLevel?: string } = {}): Promise<RunningConsole> {
  // The bridge starts logging before Fastify exists; route it to Fastify's logger once it does.
  let sink: BridgeLogger = {
    info: (o, m) => console.log(m ?? '', typeof o === 'string' ? o : JSON.stringify(o)),
    warn: (o, m) => console.warn(m ?? '', typeof o === 'string' ? o : JSON.stringify(o)),
    error: (o, m) => console.error(m ?? '', typeof o === 'string' ? o : JSON.stringify(o)),
  };
  const logger: BridgeLogger = {
    info: (o, m) => sink.info(o, m),
    warn: (o, m) => sink.warn(o, m),
    error: (o, m) => sink.error(o, m),
  };

  const runtime = await createRuntime(config, { logger });
  const app = await buildApp(runtime, opts.logLevel ? { logger: { level: opts.logLevel } } : {});
  sink = app.log as unknown as BridgeLogger;

  runtime.bridge.start();
  await app.listen({ host: config.host, port: config.port });
  const publicApi = config.api.enabled ? await buildPublicApi(runtime, { logger: false }) : null;
  if (publicApi) {
    await publicApi.listen();
    app.log.info(
      { listen: `${config.api.host}:${config.api.port}`, baseUrl: config.api.publicOrigin, proxyProtocol: config.api.proxyProtocol },
      'Public API listening (API keys only, /v1)',
    );
  }

  app.log.info(
    {
      url: config.publicOrigin,
      dataDir: config.dataDir,
      workspaceRoot: config.workspaceRoot,
      codexBin: config.codex.agentSocket ? `relay ${config.codex.agentSocket}` : config.codex.bin,
      sandbox: config.codex.sandbox,
      approvalPolicy: config.codex.approvalPolicy,
    },
    'Codex Console listening',
  );

  return {
    log: app.log,
    ownerExists: () => runtime.owner.exists(),
    hasSetupLink: () => runtime.setupLinks.hasValid(),
    newSetupLink: () => (runtime.owner.exists() ? null : setupUrl(config.publicOrigin, runtime.setupLinks.create())),
    async close() {
      await publicApi?.close();
      await app.close();
      await runtime.stop();
    },
  };
}
