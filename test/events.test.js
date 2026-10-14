// -----------------------------------------------------------------------------
// Alerts: cutting the stream, reading a document, one transition per detection.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AlertParser,
  DetectionTracker,
  normalizeTarget,
  parseAlert,
} from '../src/hikvision/events.js';

const alert = (body) =>
  `<EventNotificationAlert version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">${body}</EventNotificationAlert>`;

test('documents are found across chunks, around binary parts, in UTF-8', () => {
  const parser = new AlertParser();
  const first = alert(
    '<channelID>1</channelID><eventType>VMD</eventType><eventState>active</eventState>',
  );
  const second = alert(
    '<eventType>linedetection</eventType><eventDescription>Entrée</eventDescription>',
  );
  const stream = Buffer.concat([
    Buffer.from(`--boundary\r\nContent-Type: application/xml\r\n\r\n${first}\r\n--boundary\r\n`),
    Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x3c, 0x45]), // a JPEG part
    Buffer.from(`\r\n--boundary\r\n${second}`, 'utf8'),
  ]);
  const found = [];
  for (let index = 0; index < stream.length; index += 7) {
    found.push(...parser.push(stream.subarray(index, index + 7)));
  }
  assert.equal(found.length, 2);
  assert.equal(parseAlert(found[1]).description, 'Entrée');
});

test('an alert is read into the integration terms', () => {
  const parsed = parseAlert(
    alert(
      '<channelID>33</channelID><dynChannelID>1</dynChannelID><eventType>fielddetection</eventType>' +
        '<eventState>active</eventState><DetectionRegionList><DetectionRegionEntry>' +
        '<detectionTarget>human</detectionTarget></DetectionRegionEntry></DetectionRegionList>',
    ),
  );
  assert.equal(parsed.key, 'intrusion');
  assert.equal(parsed.active, true);
  assert.deepEqual(parsed.channels, [33, 1]);
  assert.equal(parsed.target, 'human');
  const io = parseAlert(
    alert(
      '<inputIOPortID>2</inputIOPortID><eventType>IO</eventType><eventState>inactive</eventState>',
    ),
  );
  assert.equal(io.key, 'alarm_input');
  assert.equal(io.inputPort, 2);
  assert.equal(io.active, false);
  assert.equal(parseAlert(alert('<eventType>diskfull</eventType>')).key, undefined);
  assert.equal(parseAlert('<x/>'), null);
});

test('targets are folded into person / vehicle', () => {
  assert.equal(normalizeTarget('Human'), 'human');
  assert.equal(normalizeTarget('vehicle'), 'vehicle');
  assert.equal(normalizeTarget(undefined), '');
});

test('repeated alerts make one detection, which ends after the hold', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const changes = [];
  const tracker = new DetectionTracker({
    holdMs: 10_000,
    onChange: (key, on) => changes.push(`${key}:${on ? 'on' : 'off'}`),
  });
  tracker.signal('cam|motion', true);
  t.mock.timers.tick(5_000);
  tracker.signal('cam|motion', true);
  t.mock.timers.tick(9_000);
  assert.deepEqual(changes, ['cam|motion:on']);
  t.mock.timers.tick(1_000);
  assert.deepEqual(changes, ['cam|motion:on', 'cam|motion:off']);
  assert.equal(tracker.isOn('cam|motion'), false);
});

test('an inactive alert ends the detection at once; clear() reports nothing', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const changes = [];
  const tracker = new DetectionTracker({ holdMs: 10_000, onChange: (_k, on) => changes.push(on) });
  tracker.signal('a', true);
  tracker.signal('a', false);
  tracker.signal('a', false);
  assert.deepEqual(changes, [true, false]);
  tracker.signal('b', true);
  tracker.clear();
  t.mock.timers.tick(20_000);
  assert.deepEqual(changes, [true, false, true]);
});
