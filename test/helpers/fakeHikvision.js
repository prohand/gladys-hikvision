// -----------------------------------------------------------------------------
// A fake Hikvision device on 127.0.0.1: the ISAPI paths the integration uses,
// behind real Digest authentication, with an alert stream the test drives.
//
// No hardware, no network beyond the loopback: every test that talks "to a
// camera" talks to this.
// -----------------------------------------------------------------------------

import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

const md5 = (text) => createHash('md5').update(text).digest('hex');
const XMLNS = 'xmlns="http://www.hikvision.com/ver20/XMLSchema"';

/** A JPEG of `size` bytes (valid magic, filler content). */
export function fakeJpeg(size = 2048) {
  const buffer = Buffer.alloc(size, 0x20);
  buffer[0] = 0xff;
  buffer[1] = 0xd8;
  buffer[2] = 0xff;
  buffer[size - 2] = 0xff;
  buffer[size - 1] = 0xd9;
  return buffer;
}

function responseStatus(code, text, sub) {
  return `<?xml version="1.0" encoding="UTF-8"?><ResponseStatus version="2.0" ${XMLNS}><statusCode>${code}</statusCode><statusString>${text}</statusString><subStatusCode>${sub}</subStatusCode></ResponseStatus>`;
}

function detectionXml(root, enabled) {
  return `<?xml version="1.0" encoding="UTF-8"?><${root} version="2.0" ${XMLNS}><id>1</id><enabled>${enabled}</enabled><normalizedScreenSize><normalizedScreenWidth>1000</normalizedScreenWidth></normalizedScreenSize><RegionList><Region><enabled>true</enabled></Region></RegionList></${root}>`;
}

/**
 * @param {{ username?: string, password?: string, recorder?: boolean,
 *   channels?: { id: number, name: string, online?: boolean }[], serial?: string,
 *   inputs?: number, outputs?: number, detections?: string[], ptz?: number[],
 *   presets?: { id: number, name: string }[], snapshotSize?: number, lockAfter?: number,
 *   momentary?: boolean }} [options]
 */
export async function startFakeHikvision(options = {}) {
  const device = {
    username: options.username ?? 'admin',
    password: options.password ?? 'secret',
    recorder: options.recorder ?? false,
    serial: options.serial ?? 'DS-2CD2386G2-IU20240101AAWRF12345678',
    channels: options.channels ?? [{ id: 1, name: 'Camera 01', online: true }],
    inputs: options.inputs ?? 1,
    outputs: options.outputs ?? 1,
    detections: new Set(options.detections ?? ['motion', 'line_crossing', 'intrusion']),
    ptz: new Set(options.ptz ?? []),
    presets: options.presets ?? [
      { id: 1, name: 'Gate' },
      { id: 2, name: 'Drive' },
    ],
    snapshotSize: options.snapshotSize ?? 4096,
    lockAfter: options.lockAfter ?? 5,
    momentary: options.momentary ?? true,
    deviceName: options.deviceName ?? 'IP CAMERA',
    model: options.model ?? 'DS-2CD2386G2-IU',
    failedLogins: 0,
    successfulLogins: 0,
    enabled: new Map(),
    io: { inputs: new Map(), outputs: new Map() },
    requests: [],
    streams: new Set(),
    nonces: new Set(),
    down: false,
  };
  for (let port = 1; port <= device.outputs; port += 1) device.io.outputs.set(port, false);
  for (let port = 1; port <= device.inputs; port += 1) device.io.inputs.set(port, false);

  const challenge = () => {
    const nonce = randomBytes(8).toString('hex');
    device.nonces.add(nonce);
    return `Digest realm="IP Camera(F1234)", qop="auth", nonce="${nonce}", opaque="abc", algorithm=MD5, stale="FALSE"`;
  };

  /** Check the Digest answer; null when absent. */
  const authenticate = (req) => {
    const header = req.headers.authorization;
    if (!header) return null;
    const params = {};
    for (const [, key, quoted, bare] of header.matchAll(/(\w+)=(?:"([^"]*)"|([^\s,]+))/g)) {
      params[key] = quoted ?? bare;
    }
    if (!device.nonces.has(params.nonce)) return false;
    const ha1 = md5(`${params.username}:IP Camera(F1234):${device.password}`);
    const ha2 = md5(`${req.method}:${params.uri}`);
    const expected = md5(
      `${ha1}:${params.nonce}:${params.nc}:${params.cnonce}:${params.qop}:${ha2}`,
    );
    return params.username === device.username && params.response === expected;
  };

  const send = (res, status, body, type = 'application/xml') => {
    res.writeHead(status, { 'Content-Type': type });
    res.end(body);
  };

  const detectionRoute = (path) => {
    let match = /^\/ISAPI\/System\/Video\/inputs\/channels\/(\d+)\/(motion|tamper)Detection$/.exec(
      path,
    );
    if (match && !device.recorder) return { channel: Number(match[1]), kind: match[2] };
    match =
      /^\/ISAPI\/ContentMgmt\/InputProxy\/channels\/(\d+)\/video\/(motion|tamper)Detection$/.exec(
        path,
      );
    if (match && device.recorder) return { channel: Number(match[1]), kind: match[2] };
    match = /^\/ISAPI\/Smart\/(Line|Field)Detection\/(\d+)$/.exec(path);
    if (match) {
      return {
        channel: Number(match[2]),
        kind: match[1] === 'Line' ? 'line_crossing' : 'intrusion',
      };
    }
    return null;
  };

  const handle = (req, res, body) => {
    const url = new URL(req.url, 'http://device');
    const path = url.pathname;
    device.requests.push({ method: req.method, path: `${path}${url.search}`, body });
    const notSupported = () => send(res, 403, responseStatus(4, 'Invalid Operation', 'notSupport'));

    if (path === '/ISAPI/System/deviceInfo') {
      return send(
        res,
        200,
        `<?xml version="1.0" encoding="UTF-8"?><DeviceInfo version="2.0" ${XMLNS}><deviceName>${device.deviceName}</deviceName><deviceID>x</deviceID><model>${device.model}</model><serialNumber>${device.serial}</serialNumber><macAddress>44:19:b6:00:00:01</macAddress><firmwareVersion>V5.7.12</firmwareVersion><firmwareReleasedDate>build 220819</firmwareReleasedDate><deviceType>${device.recorder ? 'NVR' : 'IPCamera'}</deviceType></DeviceInfo>`,
      );
    }
    if (path === '/ISAPI/ContentMgmt/InputProxy/channels') {
      if (!device.recorder)
        return send(res, 404, responseStatus(4, 'Invalid Operation', 'notSupport'));
      return send(
        res,
        200,
        `<InputProxyChannelList ${XMLNS}>${device.channels
          .map(
            (c) => `<InputProxyChannel><id>${c.id}</id><name>${c.name}</name></InputProxyChannel>`,
          )
          .join('')}</InputProxyChannelList>`,
      );
    }
    if (path === '/ISAPI/ContentMgmt/InputProxy/channels/status') {
      if (!device.recorder) return notSupported();
      return send(
        res,
        200,
        `<InputProxyChannelStatusList ${XMLNS}>${device.channels
          .map(
            (c) =>
              `<InputProxyChannelStatus><id>${c.id}</id><online>${c.online !== false}</online></InputProxyChannelStatus>`,
          )
          .join('')}</InputProxyChannelStatusList>`,
      );
    }
    if (path === '/ISAPI/System/Video/inputs/channels') {
      if (device.recorder) return notSupported();
      return send(
        res,
        200,
        `<VideoInputChannelList ${XMLNS}>${device.channels
          .map(
            (c) => `<VideoInputChannel><id>${c.id}</id><name>${c.name}</name></VideoInputChannel>`,
          )
          .join('')}</VideoInputChannelList>`,
      );
    }
    if (path === '/ISAPI/System/IO/inputs') {
      return send(
        res,
        200,
        `<IOInputPortList ${XMLNS}>${[...device.io.inputs.keys()]
          .map((id) => `<IOInputPort><id>${id}</id><triggering>low</triggering></IOInputPort>`)
          .join('')}</IOInputPortList>`,
      );
    }
    if (path === '/ISAPI/System/IO/outputs') {
      return send(
        res,
        200,
        `<IOOutputPortList ${XMLNS}>${[...device.io.outputs.keys()]
          .map((id) => `<IOOutputPort><id>${id}</id><name>Siren</name></IOOutputPort>`)
          .join('')}</IOOutputPortList>`,
      );
    }
    if (path === '/ISAPI/System/IO/status') {
      const port = (type, id, active) =>
        `<IOPortStatus><ioPortID>${id}</ioPortID><ioPortType>${type}</ioPortType><ioState>${active ? 'active' : 'inactive'}</ioState></IOPortStatus>`;
      return send(
        res,
        200,
        `<IOPortStatusList ${XMLNS}>${[...device.io.inputs]
          .map(([id, active]) => port('input', id, active))
          .join(
            '',
          )}${[...device.io.outputs].map(([id, active]) => port('output', id, active)).join('')}</IOPortStatusList>`,
      );
    }
    let match = /^\/ISAPI\/System\/IO\/outputs\/(\d+)\/trigger$/.exec(path);
    if (match && req.method === 'PUT') {
      device.io.outputs.set(Number(match[1]), /<outputState>high</.test(body));
      return send(res, 200, responseStatus(1, 'OK', 'ok'));
    }
    const detection = detectionRoute(path);
    if (detection) {
      const exists = device.channels.some((c) => c.id === detection.channel);
      if (!exists || !device.detections.has(detection.kind)) return notSupported();
      const key = `${detection.channel}:${detection.kind}`;
      if (req.method === 'PUT') {
        const value = /<enabled>(true|false)<\/enabled>/.exec(body)?.[1] === 'true';
        device.enabled.set(key, value);
        return send(res, 200, responseStatus(1, 'OK', 'ok'));
      }
      return send(res, 200, detectionXml('Detection', device.enabled.get(key) ?? true));
    }
    match =
      /^\/ISAPI\/(?:PTZCtrl|ContentMgmt\/PTZCtrlProxy)\/channels\/(\d+)\/(capabilities|presets|presets\/(\d+)\/goto|momentary|continuous)$/.exec(
        path,
      );
    if (match) {
      const channel = Number(match[1]);
      if (!device.ptz.has(channel)) return notSupported();
      if (match[2] === 'capabilities') return send(res, 200, `<PTZChanelCap ${XMLNS}/>`);
      if (match[2] === 'presets') {
        return send(
          res,
          200,
          `<PTZPresetList ${XMLNS}>${device.presets
            .map(
              (p) =>
                `<PTZPreset><enabled>true</enabled><id>${p.id}</id><presetName>${p.name}</presetName></PTZPreset>`,
            )
            .join(
              '',
            )}<PTZPreset><enabled>false</enabled><id>99</id><presetName>unused</presetName></PTZPreset></PTZPresetList>`,
        );
      }
      if (match[2] === 'momentary' && !device.momentary) return notSupported();
      return send(res, 200, responseStatus(1, 'OK', 'ok'));
    }
    match = /^\/ISAPI\/Streaming\/channels\/(\d+)\/picture$/.exec(path);
    if (match) {
      const sub = Number(match[1]) % 100 === 2;
      return send(
        res,
        200,
        fakeJpeg(sub ? device.snapshotSize : device.snapshotSize * 10),
        'image/jpeg',
      );
    }
    if (path === '/ISAPI/Event/notification/alertStream') {
      res.writeHead(200, { 'Content-Type': 'multipart/mixed; boundary=boundary' });
      res.write('--boundary\r\n');
      device.streams.add(res);
      res.on('close', () => device.streams.delete(res));
      return undefined;
    }
    return send(res, 404, responseStatus(4, 'Invalid Operation', 'notSupport'));
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (device.down) {
        req.socket.destroy();
        return;
      }
      const auth = authenticate(req);
      if (auth !== true) {
        if (auth === false) device.failedLogins += 1;
        const locked = device.failedLogins >= device.lockAfter;
        res.writeHead(401, { 'WWW-Authenticate': challenge(), 'Content-Type': 'application/xml' });
        res.end(
          `<?xml version="1.0" encoding="UTF-8"?><userCheck><statusValue>401</statusValue><statusString>Unauthorized</statusString><lockStatus>${locked ? 'lock' : 'unlock'}</lockStatus><retryLoginTime>${Math.max(0, device.lockAfter - device.failedLogins)}</retryLoginTime></userCheck>`,
        );
        return;
      }
      device.successfulLogins += 1;
      handle(req, res, Buffer.concat(chunks).toString('utf8'));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    device,
    host: `127.0.0.1:${port}`,
    port,
    /** Push one alert on every open alert stream. */
    alert({ type = 'VMD', state = 'active', channel = 1, port: ioPort, target, dyn }) {
      const xml =
        `<?xml version="1.0" encoding="UTF-8"?>\r\n<EventNotificationAlert version="2.0" ${XMLNS}>` +
        `<ipAddress>127.0.0.1</ipAddress><portNo>80</portNo><protocol>HTTP</protocol>` +
        (channel !== undefined ? `<channelID>${channel}</channelID>` : '') +
        (dyn !== undefined ? `<dynChannelID>${dyn}</dynChannelID>` : '') +
        (ioPort !== undefined ? `<inputIOPortID>${ioPort}</inputIOPortID>` : '') +
        `<dateTime>2026-10-14T12:00:00+02:00</dateTime><activePostCount>1</activePostCount>` +
        `<eventType>${type}</eventType><eventState>${state}</eventState><eventDescription>${type} alarm</eventDescription>` +
        (target
          ? `<DetectionRegionList><DetectionRegionEntry><detectionTarget>${target}</detectionTarget></DetectionRegionEntry></DetectionRegionList>`
          : '') +
        `</EventNotificationAlert>\r\n`;
      const part = `Content-Type: application/xml; charset="UTF-8"\r\nContent-Length: ${Buffer.byteLength(xml)}\r\n\r\n${xml}--boundary\r\n`;
      for (const stream of device.streams) stream.write(part);
    },
    /** Wait until at least one alert stream is open. */
    async waitForStream(timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (device.streams.size === 0) {
        if (Date.now() > deadline) throw new Error('no alert stream opened');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    /** Make the device stop answering (connections reset). */
    setDown(down) {
      device.down = down;
      if (down) {
        for (const stream of device.streams) stream.destroy();
        device.streams.clear();
      }
    },
    requestsTo(pattern) {
      return device.requests.filter((request) => pattern.test(request.path));
    },
    async close() {
      for (const stream of device.streams) stream.destroy();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
