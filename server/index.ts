import { ConfigError, loadConfig, loadDotEnv } from './config.js';
import type { BridgeLogger } from './codex/bridge.js';
import { buildApp } from './http/app.js';
import { buildPublicApi } from './http/publicApi.js';
import { createRuntime } from './runtime.js';

async function main(): Promise<void> {
  loadDotEnv();
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Configuration error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

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
  const app = await buildApp(runtime);
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
      codexBin: config.codex.bin,
      sandbox: config.codex.sandbox,
      approvalPolicy: config.codex.approvalPolicy,
    },
    'Codex Console listening',
  );
  if (!runtime.owner.exists()) app.log.warn('No owner account yet: run `npm run setup` to create it.');

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'Shutting down');
    await publicApi?.close();
    await app.close();
    await runtime.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
