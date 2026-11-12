// Phase 1 (release 1.2.1) security behaviour that isn't covered by the access
// matrix, restore or Apple publish tests.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, json } from './helpers.js';
import { tempDir, makeAppleBackup, zipForm } from './fixtures.js';

const PW = 'sec-pw';
const login = async (s) => {
  const res = await s.api('/api/login', json({ password: PW }));
  assert.equal(res.status, 200);
  const { token } = await res.json();
  return { Authorization: 'Bearer ' + token };
};

describe('headers (1A.3)', () => {
  let s;
  before(async () => { s = await startServer(); });
  after(() => s.stop());
  test('every response has nosniff, a referrer policy and same-origin framing', async () => {
    const r = await s.api('/');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('referrer-policy'), 'same-origin');
    assert.match(r.headers.get('content-security-policy') || '', /frame-ancestors 'self'/);
  });
  test('pages may run only their own scripts', async () => {
    const csp = (await s.api('/')).headers.get('content-security-policy') || '';
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.doesNotMatch(csp, /unsafe-eval|script-src[^;]*unsafe-inline/);
    const html = await (await s.api('/')).text();
    assert.doesNotMatch(html, /<script>(?!<\/script>)/, 'no inline <script> in the page');
    assert.doesNotMatch(html, /\son[a-z]+="/, 'no inline event handlers in the page');
  });
  test('app.js has no inline event handlers left', async () => {
    const js = await (await s.api('/app.js')).text();
    assert.doesNotMatch(js, /\son(error|click|load)="/);
  });
  test('the login cookie is SameSite=Lax', async () => {
    const t = await startServer({ ADMIN_PASSWORD: PW });
    try {
      const r = await t.api('/api/login', json({ password: PW }));
      assert.match(r.headers.get('set-cookie') || '', /SameSite=Lax/);
    } finally { await t.stop(); }
  });
});

describe('wrong-password limit (1A.4)', () => {
  let s;
  before(async () => { s = await startServer({ ADMIN_PASSWORD: PW, LOGIN_FAIL_MAX: '3' }); });
  after(() => s.stop());
  test('correct sign-ins never count against the limit', async () => {
    for (let i = 0; i < 6; i++) assert.equal((await s.api('/api/login', json({ password: PW }))).status, 200);
  });
  test('after too many wrong passwords, sign-in is paused with Retry-After', async () => {
    for (let i = 0; i < 3; i++) assert.equal((await s.api('/api/login', json({ password: 'nope' }))).status, 401);
    const r = await s.api('/api/login', json({ password: PW }));
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) > 0);
    assert.equal(typeof (await r.json()).error, 'string');
  });
  test('X-Forwarded-For is ignored unless TRUST_PROXY is set', async () => {
    const r = await s.api('/api/login', { ...json({ password: PW }), headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9' } });
    assert.equal(r.status, 429, 'a spoofed header does not get a fresh allowance');
  });
});

describe('sign out everywhere (1A.5)', () => {
  let s;
  before(async () => { s = await startServer({ ADMIN_PASSWORD: PW }); });
  after(() => s.stop());
  test('every earlier token stops working; a new sign-in works', async () => {
    const a = await login(s);
    const b = await login(s);
    assert.equal((await s.api('/api/export.csv', { headers: b })).status, 200);
    assert.equal((await s.api('/api/logout-all', { method: 'POST', headers: a })).status, 200);
    assert.notEqual((await s.api('/api/export.csv', { headers: a })).status, 200);
    assert.notEqual((await s.api('/api/export.csv', { headers: b })).status, 200);
    const c = await login(s);
    assert.equal((await s.api('/api/export.csv', { headers: c })).status, 200);
  });
  test('a visitor cannot sign everyone out', async () => {
    const r = await s.api('/api/logout-all', { method: 'POST' });
    assert.ok(r.status === 401 || r.status === 403);
  });
});

describe('malformed session input (1A.6)', () => {
  let s;
  before(async () => { s = await startServer({ ADMIN_PASSWORD: PW }); });
  after(() => s.stop());
  for (const [label, headers] of [
    ['a cookie with bad percent-encoding', { Cookie: 'yoyo_session=%E0%A4%A' }],
    ['a token with non-ASCII characters', { Authorization: 'Bearer abc.\u00e9\u00ff\u00e9' }],
    ['a token that is not base64 JSON', { Cookie: 'yoyo_session=not.json' }],
  ]) {
    test(`${label} is treated as logged out, not an error`, async () => {
      const r = await s.api('/api/config', { headers });
      assert.equal(r.status, 200);
      assert.equal((await r.json()).loggedIn, false);
    });
  }
});

describe('share page (1C.1, 1C.3)', () => {
  let s, bearer;
  before(async () => { s = await startServer({ ADMIN_PASSWORD: PW }); bearer = await login(s); });
  after(() => s.stop());
  const add = async (body) => {
    const r = await s.api('/api/yoyos', { ...json(body), headers: { ...bearer, 'Content-Type': 'application/json' } });
    assert.equal(r.status, 201);
    return (await r.json()).id;
  };
  test("a name containing $' or $& still renders the page", async () => {
    const id = await add({ brand: "Dollar$'", model: 'Amp$&', color: 'Red' });
    const html = await (await s.api(`/y/${id}`)).text();
    assert.ok(html.includes('</html>'), 'page is complete');
    assert.equal((html.match(/<head>/g) || []).length, 1, 'head not duplicated');
  });
  test('a Sold yoyo has no link preview and no visitor detail', async () => {
    const id = await add({ brand: 'Gone', model: 'Sold', color: 'Red', sale_status: 'Sold', sale_price: 99 });
    const html = await (await s.api(`/y/${id}`)).text();
    assert.ok(!html.includes('og:title'));
    assert.equal((await s.api(`/api/yoyos/${id}`)).status, 404);
    assert.equal((await s.api(`/api/yoyos/${id}`, { headers: bearer })).status, 200, 'the owner still sees it');
  });
  test('public stats do not count Sold yoyos', async () => {
    const owner = await (await s.api('/api/stats', { headers: bearer })).json();
    const pub = await (await s.api('/api/stats')).json();
    assert.ok(pub.count < owner.count, `public ${pub.count} vs owner ${owner.count}`);
    assert.ok(!('total_paid' in pub));
  });
  test('the asking price shows only while listed', async () => {
    const id = await add({ brand: 'Listed', model: 'One', color: 'Red', sale_status: 'For Sale', sale_price: 50, paid: 40 });
    const y = await (await s.api(`/api/yoyos/${id}`)).json();
    assert.equal(y.sale_price, 50);
    assert.ok(!('paid' in y) && !('created_at' in y) && !('rev' in y));
  });
});

describe('restore and sync clients (1B.5)', () => {
  let s, bearer, dir;
  before(async () => { s = await startServer({ ADMIN_PASSWORD: PW }); bearer = await login(s); dir = tempDir(); });
  after(() => s.stop());
  test('a yoyo the backup no longer has is tombstoned, so devices learn it is gone', async () => {
    const r = await s.api('/api/yoyos', { ...json({ brand: 'Web', model: 'Only', color: 'Red' }), headers: { ...bearer, 'Content-Type': 'application/json' } });
    const created = await r.json();
    const webUuid = created.uuid;
    assert.ok(webUuid, 'the owner sees the new uuid');
    const restore = await s.api('/api/restore', { ...zipForm(await makeAppleBackup(dir, [{ uuid: 'B0000000-0000-4000-8000-000000000001', brand: 'Phone', model: 'Only' }])), headers: bearer });
    assert.equal(restore.status, 200);
    const list = await (await s.api('/api/yoyos', { headers: bearer })).json();
    assert.deepEqual(list.map((y) => y.brand), ['Phone'], 'only the backup\'s yoyo is live');
    const feed = await (await s.api('/api/sync/changes?since=0', { headers: bearer })).json();
    const text = JSON.stringify(feed);
    assert.ok(text.includes(webUuid), 'the removed yoyo appears in the change feed');
  });
});
