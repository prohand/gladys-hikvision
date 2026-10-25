// -----------------------------------------------------------------------------
// The whole integration, end to end: the SDK's fake Gladys on one side, a
// fake Hikvision device on the other, index.js in between.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { register } from '../index.js';
import { AlertStream } from '../src/hikvision/alertStream.js';
import { startFakeHikvision } from './helpers/fakeHikvision.js';

const SELECTOR = 'ext:test-integration';

async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Start a fake device, a fake Gladys and the integration between them.
 * @param {import('node:test').TestContext} t
 */
async function setup(t, { device = {}, config = {}, created = true, dataDir, fake } = {}) {
  const hikvision = fake ?? (await startFakeHikvision(device));
  const dir = dataDir ?? (await mkdtemp(join(tmpdir(), 'gladys-hikvision-')));
  const gladys = createFakeGladys({
    config: {
      hosts: hikvision.host,
      username: 'admin',
      password: 'secret',
      snapshot_interval: 0,
      ...config,
    },
  });
  const { hub } = register(gladys, {
    dataDir: dir,
    createStream: (client) => new AlertStream(client, { retryMinMs: 50, retryMaxMs: 200 }),
  });
  await gladys.connect();
  if (created) {
    for (const discovered of gladys.fake.discoveredDevices) {
      await gladys.fake.deviceCreated(discovered);
    }
  }
  t.after(async () => {
    await gladys.fake.shutdown();
    if (!fake) await hikvision.close();
    if (!dataDir) await rm(dir, { recursive: true, force: true });
  });
  return { fake: hikvision, gladys, hub, dataDir: dir };
}

function camera(gladys, channel = 1) {
  return gladys.fake.discoveredDevices.find((device) => device.external_id.endsWith(`-${channel}`));
}

function feature(device, key) {
  return device.features.find((entry) => entry.external_id === `${device.external_id}:${key}`);
}

test('a camera becomes a Gladys device, with its alarm I/O', async (t) => {
  const { gladys, fake } = await setup(t);
  const devices = gladys.fake.discoveredDevices;
  assert.equal(devices.length, 2);

  const cam = camera(gladys);
  assert.equal(cam.external_id, `${SELECTOR}:camera:${fake.device.serial}-1`);
  assert.equal(cam.name, 'DS-2CD2386G2-IU'); // "IP CAMERA" and "Camera 01" are no names
  assert.deepEqual(
    cam.features.map((entry) => entry.external_id.slice(cam.external_id.length + 1)),
    [
      'image',
      'enabled',
      'motion',
      'line-crossing',
      'intrusion',
      'motion-enabled',
      'line-crossing-enabled',
      'intrusion-enabled',
    ],
  );
  for (const entry of cam.features) {
    assert.notEqual(entry.min, undefined, `${entry.external_id} has a min`);
    assert.notEqual(entry.max, undefined, `${entry.external_id} has a max`);
  }

  const io = devices.find((device) => device.external_id.includes(':alarm-io:'));
  assert.deepEqual(
    io.features.map((entry) => entry.external_id.split(':').pop()),
    ['input-1', 'output-1'],
  );

  assert.equal(gladys.fake.connectionStatus.connected, true);
  // The detection switches are read and published, and the privacy gate is open.
  assert.equal(gladys.fake.lastState(`${cam.external_id}:motion-enabled`), 1);
  assert.equal(gladys.fake.lastState(`${cam.external_id}:enabled`), 1);
  assert.equal(feature(cam, 'enabled').type, 'enabled');

  // Once the event stream is up, the badge is plain local.
  await fake.waitForStream();
  await waitFor(() => {
    const last = gladys.fake.transports
      .filter((entry) => entry.device_external_id === cam.external_id)
      .at(-1);
    return last?.transport === 'local' && !last.degraded;
  });
});

test('a detection lights its feature and fires ONE scene event', async (t) => {
  const { gladys, fake } = await setup(t);
  const cam = camera(gladys);
  await fake.waitForStream();

  fake.alert({ type: 'VMD' });
  fake.alert({ type: 'VMD' });
  fake.alert({ type: 'VMD' });
  await waitFor(() => gladys.fake.lastState(`${cam.external_id}:motion`) === 1);
  fake.alert({ type: 'videoloss', state: 'inactive' }); // the heartbeat
  fake.alert({ type: 'VMD', state: 'inactive' });
  await waitFor(() => gladys.fake.lastState(`${cam.external_id}:motion`) === 0);

  const events = gladys.fake.sceneEvents.filter((event) => event.key === 'event_detected');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].data, {
    device: cam.external_id,
    event_type: 'motion',
    target: '',
    device_name: cam.name,
    channel: 1,
    description: 'VMD alarm',
  });
});

test('a smart event carries its target', async (t) => {
  const { gladys, fake } = await setup(t);
  const cam = camera(gladys);
  await fake.waitForStream();
  fake.alert({ type: 'fielddetection', target: 'human' });
  const event = await waitFor(() =>
    gladys.fake.sceneEvents.find((e) => e.key === 'event_detected'),
  );
  assert.equal(event.data.event_type, 'intrusion');
  assert.equal(event.data.target, 'human');
  assert.equal(gladys.fake.lastState(`${cam.external_id}:intrusion`), 1);
});

test('alarm inputs follow the events, alarm outputs follow Gladys', async (t) => {
  const { gladys, fake } = await setup(t);
  const io = gladys.fake.discoveredDevices.find((device) =>
    device.external_id.includes(':alarm-io:'),
  );
  await fake.waitForStream();

  fake.alert({ type: 'IO', channel: undefined, port: 1 });
  await waitFor(() => gladys.fake.lastState(`${io.external_id}:input-1`) === 1);
  const event = gladys.fake.sceneEvents.find((e) => e.data.event_type === 'alarm_input');
  assert.equal(event.data.device, io.external_id);
  fake.alert({ type: 'IO', channel: undefined, port: 1, state: 'inactive' });
  await waitFor(() => gladys.fake.lastState(`${io.external_id}:input-1`) === 0);

  const ack = await gladys.fake.setValue(io, feature(io, 'output-1'), 1);
  assert.equal(ack.success, true, ack.error);
  assert.equal(fake.device.io.outputs.get(1), true);
  assert.equal(gladys.fake.lastState(`${io.external_id}:output-1`), 1);
});

test('a detection switch rewrites only <enabled> on the camera', async (t) => {
  const { gladys, fake } = await setup(t);
  const cam = camera(gladys);
  const ack = await gladys.fake.setValue(cam, feature(cam, 'motion-enabled'), 0);
  assert.equal(ack.success, true, ack.error);
  const put = fake.device.requests.find(
    (r) => r.method === 'PUT' && /motionDetection/.test(r.path),
  );
  assert.match(put.body, /<Detection version="2.0"[^>]*><id>1<\/id><enabled>false<\/enabled>/);
  assert.match(put.body, /<Region><enabled>true<\/enabled><\/Region>/);
  assert.equal(gladys.fake.lastState(`${cam.external_id}:motion-enabled`), 0);
});

test('Gladys gets a fresh image on demand, and the snapshot loop pushes one', async (t) => {
  const { gladys, hub } = await setup(t);
  const cam = camera(gladys);
  const ack = await gladys.fake.getImage(cam);
  assert.equal(ack.success, true, ack.error);
  assert.match(ack.data.image, /^image\/jpg;base64,\/9j\//);

  await hub.snapshotTick();
  assert.equal(gladys.fake.cameraImages.length, 1);
  assert.equal(gladys.fake.cameraImages[0].device_external_id, cam.external_id);
});

test('a camera disabled in Gladys sends no image nor detection, even after a restart', async (t) => {
  const first = await startFakeHikvision();
  const dataDir = await mkdtemp(join(tmpdir(), 'gladys-hikvision-'));
  t.after(async () => {
    await first.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  {
    const { gladys, hub, fake } = await setup(t, { fake: first, dataDir });
    const cam = camera(gladys);
    const ack = await gladys.fake.setValue(cam, feature(cam, 'enabled'), 0);
    assert.equal(ack.success, true, ack.error);
    assert.equal(gladys.fake.lastState(`${cam.external_id}:enabled`), 0);

    const image = await gladys.fake.getImage(cam);
    assert.equal(image.success, false);
    await hub.snapshotTick();
    assert.equal(gladys.fake.cameraImages.length, 0);
    const snapshot = await gladys.fake.sceneAction('take_snapshot', { device: cam.external_id });
    assert.deepEqual(snapshot.data.outputs, { captured: false });

    await fake.waitForStream();
    fake.alert({ type: 'VMD' });
    fake.alert({ type: 'IO', channel: undefined, port: 1 }); // the contacts are not the camera
    await waitFor(() => gladys.fake.sceneEvents.some((e) => e.data.event_type === 'alarm_input'));
    assert.ok(!gladys.fake.sceneEvents.some((e) => e.data.event_type === 'motion'));
    assert.notEqual(gladys.fake.lastState(`${cam.external_id}:motion`), 1);

    const widget = await gladys.fake.widgetGet('hikvision', { language: 'en' });
    assert.deepEqual(validateWidgetContent(widget.data.content), []);
    const components = widget.data.content.components;
    assert.ok(!components.some((component) => component.type === 'image'));
    const status = components.find((component) => component.type === 'status');
    assert.equal(status.items[0].value.en, 'Disabled in Gladys');
    await gladys.fake.shutdown();
  }
  const saved = JSON.parse(await readFile(join(dataDir, 'disabled-cameras.json'), 'utf8'));
  assert.deepEqual(saved, { disabled: [`${first.device.serial}-1`] });

  const { gladys } = await setup(t, { fake: first, dataDir });
  const cam = camera(gladys);
  assert.equal(gladys.fake.lastState(`${cam.external_id}:enabled`), 0);
  const ack = await gladys.fake.setValue(cam, feature(cam, 'enabled'), 1);
  assert.equal(ack.success, true, ack.error);
  assert.equal((await gladys.fake.getImage(cam)).success, true);
});

test('no image is pushed for a camera the user did not create', async (t) => {
  const { gladys, hub } = await setup(t, { created: false });
  await hub.snapshotTick();
  assert.equal(gladys.fake.cameraImages.length, 0);
});

test('scene actions: snapshot, detection, preset', async (t) => {
  const { gladys, fake } = await setup(t);
  const cam = camera(gladys);

  let ack = await gladys.fake.sceneAction('take_snapshot', { device: cam.external_id });
  assert.deepEqual(ack.data.outputs, { captured: true });
  assert.equal(gladys.fake.cameraImages.length, 1);

  ack = await gladys.fake.sceneAction('set_detection', {
    device: cam.external_id,
    detection: 'line_crossing',
    enabled: false,
  });
  assert.deepEqual(ack.data.outputs, { applied: true, enabled: false });
  assert.equal(fake.device.enabled.get('1:line_crossing'), false);
  assert.equal(gladys.fake.lastState(`${cam.external_id}:line-crossing-enabled`), 0);

  // This camera has no PTZ: an output, not a failure.
  ack = await gladys.fake.sceneAction('goto_preset', { device: cam.external_id, preset: 1 });
  assert.equal(ack.success, true);
  assert.deepEqual(ack.data.outputs, { moved: false });

  ack = await gladys.fake.sceneAction('take_snapshot', { device: `${SELECTOR}:camera:unknown-1` });
  assert.deepEqual(ack.data.outputs, { captured: false });
});

test('a PTZ camera gets its presets and moves by steps', async (t) => {
  const { gladys, fake } = await setup(t, { device: { ptz: [1] } });
  const cam = camera(gladys);
  const preset = feature(cam, 'ptz-preset');
  assert.deepEqual(
    preset.supported_options.map((option) => [option.value, option.label]),
    [
      [1, 'Gate'],
      [2, 'Drive'],
    ],
  );
  assert.ok(feature(cam, 'ptz-move'));

  let ack = await gladys.fake.setValue(cam, preset, 2);
  assert.equal(ack.success, true, ack.error);
  assert.equal(fake.requestsTo(/\/presets\/2\/goto$/).length, 1);

  ack = await gladys.fake.setValue(cam, feature(cam, 'ptz-move'), 1);
  assert.equal(ack.success, true, ack.error);
  const step = fake.requestsTo(/\/momentary$/)[0];
  assert.match(step.body, /<pan>-60<\/pan>.*<duration>600<\/duration>/);

  ack = await gladys.fake.sceneAction('goto_preset', { device: cam.external_id, preset: 1 });
  assert.deepEqual(ack.data.outputs, { moved: true });
});

test('without momentary moves, a continuous move is always stopped', async (t) => {
  const { gladys, fake } = await setup(t, { device: { ptz: [1], momentary: false } });
  const cam = camera(gladys);
  const ack = await gladys.fake.setValue(cam, feature(cam, 'ptz-move'), 5);
  assert.equal(ack.success, true, ack.error);
  await waitFor(() => fake.requestsTo(/\/continuous$/).length === 2);
  const [move, stop] = fake.requestsTo(/\/continuous$/);
  assert.match(move.body, /<zoom>60<\/zoom>/);
  assert.match(stop.body, /<pan>0<\/pan><tilt>0<\/tilt><zoom>0<\/zoom>/);
});

test('a recorder brings one device per camera, online or not', async (t) => {
  const { gladys, fake, hub } = await setup(t, {
    device: {
      recorder: true,
      deviceName: 'NVR',
      channels: [
        { id: 1, name: 'Front door', online: true },
        { id: 2, name: 'Garden', online: false },
      ],
    },
  });
  const front = camera(gladys, 1);
  const garden = camera(gladys, 2);
  assert.equal(front.name, 'Front door');
  assert.equal(garden.name, 'Garden');
  // The proxied paths are the ones a recorder answers.
  assert.ok(fake.requestsTo(/InputProxy\/channels\/1\/video\/motionDetection/).length > 0);

  const lastTransport = (id) =>
    gladys.fake.transports.filter((entry) => entry.device_external_id === id).at(-1).transport;
  assert.equal(lastTransport(garden.external_id), 'unreachable');

  // Older recorders number IP cameras after 32 analog inputs.
  await fake.waitForStream();
  fake.alert({ type: 'linedetection', channel: 33 });
  const event = await waitFor(() =>
    gladys.fake.sceneEvents.find((e) => e.key === 'event_detected'),
  );
  assert.equal(event.data.device, front.external_id);

  fake.device.channels[1].online = true;
  await hub.refreshStation(hub.stations[0]);
  const back = gladys.fake.sceneEvents.find((e) => e.key === 'camera_online');
  assert.deepEqual(back.data, { device: garden.external_id, device_name: 'Garden' });
  assert.equal(lastTransport(garden.external_id), 'local');
});

test('a device that stops answering: offline event, badge, status; then back', async (t) => {
  const { gladys, fake, hub } = await setup(t);
  const cam = camera(gladys);
  const station = hub.stations[0];

  fake.setDown(true);
  await hub.refreshStation(station);
  const offline = gladys.fake.sceneEvents.find((e) => e.key === 'camera_offline');
  assert.equal(offline.data.device, cam.external_id);
  assert.equal(offline.data.reason, 'unreachable');
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.fr, /injoignable/);
  const last = gladys.fake.transports
    .filter((e) => e.device_external_id === cam.external_id)
    .at(-1);
  assert.equal(last.transport, 'unreachable');

  fake.setDown(false);
  await hub.refreshStation(station);
  assert.ok(gladys.fake.sceneEvents.find((e) => e.key === 'camera_online'));
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a refused password is tried once, then only when the user asks', async (t) => {
  const { gladys, fake, hub } = await setup(t, { config: { password: 'wrong' } });
  assert.equal(fake.device.failedLogins, 1);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /password refused/);

  await hub.refreshStation(hub.stations[0]);
  await hub.refreshStation(hub.stations[0]);
  assert.equal(fake.device.failedLogins, 1, 'no automatic retry');

  const ack = await gladys.fake.action('test_connection');
  assert.match(ack.data.message.fr, /❌ .*mot de passe refusé/);
  assert.equal(fake.device.failedLogins, 2);
});

test('Test the connection says what Gladys gets', async (t) => {
  const { gladys, fake } = await setup(t, { config: { hosts: '' }, created: false });
  let ack = await gladys.fake.action('test_connection');
  assert.match(ack.data.message.en, /No address yet/);
  assert.equal(gladys.fake.connectionStatus.connected, false);

  await gladys.fake.configUpdated({
    hosts: `${fake.host}, ftp://nvr`,
    username: 'admin',
    password: 'secret',
    snapshot_interval: 0,
  });
  ack = await gladys.fake.action('test_connection');
  const { en, fr, de, es } = ack.data.message;
  assert.match(en, /✅ .*DS-2CD2386G2-IU \(camera, V5\.7\.12 build 220819\)/);
  assert.match(en, /detections: motion, line crossing, intrusion/);
  assert.match(en, /events: received live/);
  assert.match(en, /alarm I\/O: 1 in, 1 out/);
  assert.match(en, /⚠️ ftp:\/\/nvr — not an address/);
  assert.match(fr, /détections : mouvement, franchissement de ligne, intrusion/);
  assert.match(de, /Ereignisse: live empfangen/);
  assert.match(es, /eventos: recibidos en directo/);
});

test('the widget fits the vocabulary, serves its image and arms / disarms', async (t) => {
  const { gladys, fake } = await setup(t);
  const cam = camera(gladys);
  await fake.waitForStream();
  fake.alert({ type: 'VMD' });
  await waitFor(() => gladys.fake.sceneEvents.length > 0);

  const ack = await gladys.fake.widgetGet('hikvision', { language: 'fr' });
  assert.equal(ack.success, true, ack.error);
  const { content } = ack.data;
  assert.deepEqual(validateWidgetContent(content), []);
  const image = content.components.find((component) => component.type === 'image');
  assert.ok(image, 'the camera image is shown');
  const status = content.components.find((component) => component.type === 'status');
  assert.match(status.items[0].value.fr, /^Mouvement · à l'instant$/);

  const bytes = await gladys.fake.widgetGetImage(image.key);
  assert.equal(bytes.success, true, bytes.error);
  assert.equal(Buffer.from(bytes.data.image, 'base64')[0], 0xff);

  const disarm = await gladys.fake.widgetAction('hikvision', 'disarm', {});
  assert.equal(disarm.success, true, disarm.error);
  assert.equal(disarm.data.message.en, 'Detections off: 3');
  assert.equal(fake.device.enabled.get('1:motion'), false);
  assert.equal(gladys.fake.lastState(`${cam.external_id}:intrusion-enabled`), 0);

  const snap = await gladys.fake.widgetAction('hikvision', 'snapshot', { device: cam.external_id });
  assert.equal(snap.success, true, snap.error);
  assert.ok(gladys.fake.widgetRefreshes.includes('hikvision'));
});

test('the widget without any camera is a valid empty state', async (t) => {
  const { gladys } = await setup(t, { config: { hosts: '' }, created: false });
  const ack = await gladys.fake.widgetGet('hikvision');
  assert.deepEqual(validateWidgetContent(ack.data.content), []);
});

test('a device off at startup keeps its devices, known from /data', async (t) => {
  const first = await startFakeHikvision();
  const dataDir = await mkdtemp(join(tmpdir(), 'gladys-hikvision-'));
  t.after(async () => {
    await first.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  {
    const { gladys } = await setup(t, { fake: first, dataDir });
    assert.equal(gladys.fake.discoveredDevices.length, 2);
    await gladys.fake.shutdown();
  }
  const saved = JSON.parse(await readFile(join(dataDir, 'stations.json'), 'utf8'));
  assert.equal(Object.values(saved)[0].info.serialNumber, first.device.serial);
  assert.doesNotMatch(JSON.stringify(saved), /secret/);

  first.setDown(true);
  const { gladys } = await setup(t, { fake: first, dataDir });
  assert.equal(gladys.fake.discoveredDevices.length, 2);
  const cam = camera(gladys);
  const last = gladys.fake.transports
    .filter((e) => e.device_external_id === cam.external_id)
    .at(-1);
  assert.equal(last.transport, 'unreachable');
  const ack = await gladys.fake.getImage(cam);
  assert.equal(ack.success, false);
});

test('a scan publishes the devices again', async (t) => {
  const { gladys } = await setup(t, { created: false });
  const before = gladys.fake.requests.filter((r) => r.path.includes('discovered')).length;
  await gladys.fake.scanRequest();
  const after = gladys.fake.requests.filter((r) => r.path.includes('discovered')).length;
  assert.equal(after, before + 1);
});
