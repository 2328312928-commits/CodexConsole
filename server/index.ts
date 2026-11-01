import { ConfigError, loadConfig, loadDotEnv } from './config.js';
import { startConsole } from './start.js';

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

  const running = await startConsole(config);
  if (!running.ownerExists()) {
    // Finish setup in the browser; the installer prints its own link, so keep a valid one.
    const link = running.hasSetupLink() ? null : running.newSetupLink();
    running.log.warn(link ? `No owner account yet. Finish setup in your browser: ${link}` : 'No owner account yet: open the setup link the installer printed (or run `npm run setup -- --setup-link`).');
  }

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    running.log.info({ signal }, 'Shutting down');
    await running.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
