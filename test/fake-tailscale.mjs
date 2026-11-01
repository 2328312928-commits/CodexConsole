#!/usr/bin/env node
// A pretend `tailscale` command for the tests. FAKE_TS_* settings describe the tailnet;
// FAKE_TS_LOG collects every command line it was run with.
import fs from 'node:fs';

const args = process.argv.slice(2);
const env = process.env;
if (env.FAKE_TS_LOG) fs.appendFileSync(env.FAKE_TS_LOG, `${JSON.stringify(args)}\n`);
const dns = env.FAKE_TS_DNS ?? 'my-pc.tail0000.ts.net';

if (args[0] === 'status' && args[1] === '--json') {
  if (env.FAKE_TS_STATE === 'down') {
    process.stderr.write('failed to connect to local Tailscale service; is Tailscale running?\n');
    process.exit(1);
  }
  process.stdout.write(
    JSON.stringify({
      Version: env.FAKE_TS_VERSION ?? '1.90.4-t1234abcd-g5678',
      BackendState: env.FAKE_TS_STATE ?? 'Running',
      Self: { HostName: dns.split('.')[0], DNSName: `${dns}.` },
      CertDomains: env.FAKE_TS_NO_CERTS ? null : [dns],
      CurrentTailnet: { Name: 'owner@example.com', MagicDNSSuffix: dns.split('.').slice(1).join('.'), MagicDNSEnabled: true },
    }),
  );
  process.exit(0);
}

if (args[0] === 'serve' && args[1] === 'status') {
  process.stdout.write(env.FAKE_TS_SERVE_JSON ?? '{}');
  process.exit(0);
}

if ((args[0] === 'funnel' || args[0] === 'serve') && args.includes('--bg')) {
  if (env.FAKE_TS_CONSENT) {
    process.stdout.write(`${args[0] === 'funnel' ? 'Funnel' : 'Serve'} is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/${args[0]}?node=nTEST123\n\n`);
    await new Promise((r) => setTimeout(r, 200));
  }
  if (env.FAKE_TS_PUBLISH_FAIL) {
    process.stderr.write(`${env.FAKE_TS_PUBLISH_FAIL}\n`);
    process.exit(1);
  }
  process.stdout.write(`Available ${args[0] === 'funnel' ? 'on the internet' : 'within your tailnet'}:\n\nhttps://${dns}/\n|-- proxy ${args.at(-1)}\n\n${args[0] === 'funnel' ? 'Funnel' : 'Serve'} started and running in the background.\n`);
  process.exit(0);
}

if (args[0] === 'funnel' && args.at(-1) === 'off') process.exit(0);

process.stderr.write(`fake tailscale: unknown command ${args.join(' ')}\n`);
process.exit(2);
