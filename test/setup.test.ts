import { afterEach, describe, expect, it } from 'vitest';
import { totpCode } from '../server/auth/totp.js';
import { Client, makeHarness, type Harness } from './helpers.js';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const PASSWORD = 'a long enough admin password';

describe('setup in the browser', () => {
  it('finishes setup from the one-time link: owner, authenticator, first key, signed in with admin open', async () => {
    h = await makeHarness({ owner: false });
    const browser = new Client(h.app);
    expect((await browser.get('/api/auth/state')).json()).toMatchObject({ setupComplete: false, loggedIn: false });
    expect((await browser.get('/api/setup/state')).json()).toEqual({ needed: true });
    expect((await browser.get('/api/sessions')).json().error.code).toBe('setup_required');

    expect((await browser.post('/api/setup/authenticator', { token: 'not-the-link' })).json().error.code).toBe('invalid_setup_link');
    const token = h.runtime.setupLinks.create();
    const auth = (await browser.post('/api/setup/authenticator', { token })).json();
    expect(auth.secret).toMatch(/^[A-Z2-7]{16,}$/);
    expect(auth.qrSvg).toContain('<svg');

    const finish = (body: Record<string, unknown>) => browser.post('/api/setup/finish', { token, password: PASSWORD, totpSecret: auth.secret, code: totpCode(auth.secret, Date.now()), ...body });
    expect((await finish({ password: 'too short' })).json().error.code).toBe('password_too_short');
    expect((await finish({ code: '000000' })).json().error.code).toBe('invalid_totp');

    const code = totpCode(auth.secret, Date.now());
    const done = await finish({ code, keyLabel: 'Laptop' });
    expect(done.statusCode).toBe(200);
    const body = done.json();
    expect(body.key).toMatch(/^cck_[0-9a-f]{16}\./);
    expect(body.auth).toMatchObject({ setupComplete: true, loggedIn: true, admin: true, key: { label: 'Laptop', access: 'full' } });
    expect(h.runtime.owner.exists()).toBe(true);
    // This browser can sign Codex in right away; the code it used is spent.
    expect((await browser.get('/api/admin/codex')).statusCode).toBe(200);
    expect((await browser.get('/api/admin/security?kind=setup_completed')).json().total).toBe(1);
    await browser.post('/api/auth/admin/lock');
    expect((await browser.post('/api/auth/admin', { password: PASSWORD, code })).json().error.code).toBe('invalid_credentials');
    // The first key signs in from another computer too.
    expect((await new Client(h.app).post('/api/auth/key', { key: body.key })).statusCode).toBe(200);

    // The link works once, and setup cannot run again.
    expect((await browser.post('/api/setup/authenticator', { token })).json().error.code).toBe('setup_already_done');
    expect((await new Client(h.app).get('/api/setup/state')).json()).toEqual({ needed: false });
  });

  it('only the newest link works, and guessing gets an address locked', async () => {
    h = await makeHarness({ owner: false });
    const first = h.runtime.setupLinks.create();
    const second = h.runtime.setupLinks.create();
    const browser = new Client(h.app, '198.51.100.40');
    expect((await browser.post('/api/setup/authenticator', { token: first })).json().error.code).toBe('invalid_setup_link');
    expect((await browser.post('/api/setup/authenticator', { token: second })).statusCode).toBe(200);
    for (let i = 0; i < 10; i++) await browser.post('/api/setup/authenticator', { token: `guess-${i}` });
    expect((await browser.post('/api/setup/authenticator', { token: second })).json().error.code).toBe('login_locked');
    // Another address still can.
    expect((await new Client(h.app, '203.0.113.41').post('/api/setup/authenticator', { token: second })).statusCode).toBe(200);
  });
});
