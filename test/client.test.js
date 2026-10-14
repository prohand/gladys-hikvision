// -----------------------------------------------------------------------------
// The ISAPI client against the fake device: authentication, errors, and the
// one rule above all — a wrong password costs one failed login, not more.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IsapiClient } from '../src/hikvision/client.js';
import { getSnapshot, MAX_IMAGE_BYTES } from '../src/hikvision/isapi.js';
import { startFakeHikvision } from './helpers/fakeHikvision.js';

function clientFor(fake, password = 'secret') {
  return new IsapiClient({
    baseUrl: `http://${fake.host}`,
    label: fake.host,
    username: 'admin',
    password,
    timeoutMs: 2000,
  });
}

test('authenticates with Digest, then reuses the challenge', async (t) => {
  const fake = await startFakeHikvision();
  const client = clientFor(fake);
  t.after(async () => {
    client.close();
    await fake.close();
  });
  const first = await client.text('GET', '/ISAPI/System/deviceInfo');
  assert.match(first, /serialNumber/);
  const before = fake.device.requests.length;
  await client.text('GET', '/ISAPI/System/deviceInfo');
  // One more request reached the handler, and no 401 round trip happened.
  assert.equal(fake.device.requests.length, before + 1);
  assert.equal(fake.device.failedLogins, 0);
});

test('a wrong password is one failed login per request', async (t) => {
  const fake = await startFakeHikvision();
  const client = clientFor(fake, 'wrong');
  t.after(async () => {
    client.close();
    await fake.close();
  });
  await assert.rejects(client.text('GET', '/ISAPI/System/deviceInfo'), (error) => {
    assert.equal(error.code, 'auth');
    assert.equal(error.retryLoginTime, 4);
    return true;
  });
  assert.equal(fake.device.failedLogins, 1);
});

test('a locked account is told apart from a wrong password', async (t) => {
  const fake = await startFakeHikvision({ lockAfter: 1 });
  const client = clientFor(fake, 'wrong');
  t.after(async () => {
    client.close();
    await fake.close();
  });
  await assert.rejects(client.text('GET', '/ISAPI/System/deviceInfo'), { code: 'locked' });
});

test('an unknown path is not_supported, a closed port is unreachable', async (t) => {
  const fake = await startFakeHikvision();
  const client = clientFor(fake);
  t.after(() => client.close());
  await assert.rejects(client.text('GET', '/ISAPI/Nothing'), { code: 'not_supported' });
  await fake.close();
  const closed = clientFor(fake);
  await assert.rejects(closed.text('GET', '/ISAPI/System/deviceInfo'), { code: 'unreachable' });
  closed.close();
});

test('snapshots stay under 150 KB, the sub-stream taking over', async (t) => {
  const fake = await startFakeHikvision({ snapshotSize: 20_000 });
  const client = clientFor(fake);
  t.after(async () => {
    client.close();
    await fake.close();
  });
  // Main stream: 200 KB in the fake, too heavy -> the sub-stream is used.
  const jpeg = await getSnapshot(client, 1, 'main');
  assert.equal(jpeg.length, 20_000);
  assert.deepEqual(
    fake.requestsTo(/picture/).map((request) => request.path.split('?')[0]),
    ['/ISAPI/Streaming/channels/101/picture', '/ISAPI/Streaming/channels/102/picture'],
  );
  fake.device.snapshotSize = MAX_IMAGE_BYTES + 1;
  await assert.rejects(getSnapshot(client, 1, 'sub'), { code: 'too_large' });
});
