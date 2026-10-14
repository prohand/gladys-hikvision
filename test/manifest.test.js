// -----------------------------------------------------------------------------
// Consistency between `gladys-assistant-integration.json` and the code. The
// store indexer validates the manifest, but nothing there can know which
// handlers the code registers, which triggers it fires or which defaults it
// applies: these tests keep both sides in step.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { DEFAULT_CONFIG } from '../src/config.js';
import { LANGUAGES } from '../src/i18n.js';
import { EVENT_KEYS } from '../src/hikvision/events.js';
import { DETECTION_KINDS } from '../src/hikvision/isapi.js';
import { SCENE_TRIGGERS, createSceneActions } from '../src/capabilities/scenes.js';
import { createWidgets } from '../src/capabilities/widget.js';

const read = async (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(await read('gladys-assistant-integration.json'));
const pkg = JSON.parse(await read('package.json'));
const indexSource = await read('index.js');

/** Every multi-language text of the manifest, with where it is. */
function texts(node, path = 'manifest') {
  const found = [];
  if (Array.isArray(node)) {
    node.forEach((child, index) => found.push(...texts(child, `${path}[${index}]`)));
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (['label', 'description', 'placeholder'].includes(key)) {
        found.push({ path: `${path}.${key}`, value });
      } else {
        found.push(...texts(value, `${path}.${key}`));
      }
    }
  }
  return found;
}

test('every text is written in the four languages of Gladys', () => {
  for (const { path, value } of texts(manifest)) {
    assert.equal(typeof value, 'object', `${path} must be a multi-language object`);
    assert.deepEqual(Object.keys(value).sort(), [...LANGUAGES].sort(), `${path} languages`);
    for (const language of LANGUAGES) {
      assert.ok(value[language].trim().length > 0, `${path}.${language} is empty`);
    }
  }
});

test('the catalog card fits what the store allows', () => {
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
  for (const [language, text] of Object.entries(manifest.description)) {
    assert.ok(
      text.length >= 10 && text.length <= 100,
      `description.${language}: ${text.length} chars`,
    );
  }
  assert.deepEqual(manifest.transports, ['local']);
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
});

test('version, image tag and package.json agree', () => {
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/prohand/gladys-hikvision:${pkg.version}`);
});

test('the capability fields come with a Gladys that knows them', () => {
  assert.match(manifest.gladys_version, /^>=5\.(\d+)\.\d+$/);
  const minor = Number(/^>=5\.(\d+)/.exec(manifest.gladys_version)[1]);
  assert.ok(minor >= 1, 'widgets / scene_triggers / scene_actions need >=5.1.0');
});

test('config_schema defaults are DEFAULT_CONFIG', () => {
  for (const field of manifest.config_schema) {
    if (field.default !== undefined) {
      assert.equal(DEFAULT_CONFIG[field.key], field.default, `default of ${field.key}`);
    }
    if (field.type !== 'section') {
      assert.ok(field.key in DEFAULT_CONFIG, `${field.key} missing from DEFAULT_CONFIG`);
    }
  }
});

test('field shapes the store accepts', () => {
  const fields = [
    ...manifest.config_schema,
    ...manifest.actions.flatMap((action) => action.fields ?? []),
    ...manifest.widgets.flatMap((widget) => widget.settings ?? []),
    ...manifest.scene_triggers.flatMap((trigger) => trigger.fields ?? []),
    ...manifest.scene_actions.flatMap((action) => action.fields ?? []),
  ];
  for (const field of fields) {
    assert.match(field.key, /^[a-z0-9_]+$/);
    if (field.placeholder !== undefined) {
      assert.ok(['string', 'number', 'secret'].includes(field.type), `${field.key}: placeholder`);
    }
    if (field.min !== undefined || field.max !== undefined) {
      assert.equal(field.type, 'number', `${field.key}: min/max on a number only`);
    }
    if (field.source !== undefined) {
      assert.equal(field.options, undefined, `${field.key}: source or options, not both`);
      assert.equal(field.default, undefined, `${field.key}: no default on a dynamic select`);
    }
  }
  for (const trigger of manifest.scene_triggers) {
    for (const field of trigger.fields ?? []) {
      assert.notEqual(field.type, 'boolean', 'a trigger filter cannot be a boolean');
    }
  }
});

test('every manifest action is registered in index.js', () => {
  for (const action of manifest.actions) {
    assert.match(indexSource, new RegExp(`onAction\\('${action.key}'`), action.key);
  }
});

test('scene actions: declared = handled', () => {
  const handled = Object.keys(createSceneActions(() => null)).sort();
  assert.deepEqual(manifest.scene_actions.map((action) => action.key).sort(), handled);
});

test('scene triggers: declared = fired', () => {
  assert.deepEqual(
    manifest.scene_triggers.map((trigger) => trigger.key).sort(),
    [...SCENE_TRIGGERS].sort(),
  );
});

test('the event filter lists every event the code emits', () => {
  const trigger = manifest.scene_triggers.find((entry) => entry.key === 'event_detected');
  const options = trigger.fields.find((field) => field.key === 'event_type').options;
  assert.deepEqual(
    options.map((option) => option.value),
    EVENT_KEYS,
  );
  const action = manifest.scene_actions.find((entry) => entry.key === 'set_detection');
  const detections = action.fields.find((field) => field.key === 'detection').options;
  assert.deepEqual(
    detections.map((option) => option.value),
    DETECTION_KINDS,
  );
});

test('widgets: declared = handled', () => {
  assert.deepEqual(
    manifest.widgets.map((widget) => widget.key),
    Object.keys(createWidgets(() => null)),
  );
  for (const widget of manifest.widgets) {
    for (const language of LANGUAGES) {
      const length = widget.label[language].length;
      assert.ok(length >= 3 && length <= 30, `widget label ${language}`);
      assert.ok(widget.description[language].length <= 100, `widget description ${language}`);
    }
  }
});

test('the user documentation exists in every language, long enough for the store', async () => {
  for (const language of LANGUAGES) {
    const text = await read(`docs/${language}.md`);
    assert.ok(text.length >= 300, `docs/${language}.md is too short`);
  }
});

test('the cover is a PNG under 150 KB', async () => {
  const file = new URL('../cover.png', import.meta.url);
  const { size } = await stat(file);
  assert.ok(size <= 150 * 1024, `cover.png weighs ${size} bytes`);
  const bytes = await readFile(file);
  assert.equal(bytes.toString('hex', 0, 8), '89504e470d0a1a0a');
  assert.equal(bytes.readUInt32BE(16), 800);
  assert.equal(bytes.readUInt32BE(20), 534);
});
