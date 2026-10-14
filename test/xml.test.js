// -----------------------------------------------------------------------------
// The XML helpers the ISAPI answers go through.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBlocks, readBoolean, readTag, replaceFirstTag } from '../src/hikvision/xml.js';

const DOC = `<?xml version="1.0"?><List xmlns="x"><Item><id>1</id><name>Entr&#233;e &amp; garage</name></Item><Item version="2"><id>2</id><name/></Item></List>`;

test('reads tags, decoding entities', () => {
  assert.equal(readTag(DOC, 'id'), '1');
  assert.equal(readTag(DOC, 'name'), 'Entrée & garage');
  assert.equal(readTag(DOC, 'missing'), undefined);
});

test('lists repeated blocks without mixing up the list itself', () => {
  const blocks = readBlocks(DOC, 'Item');
  assert.equal(blocks.length, 2);
  assert.equal(readTag(blocks[1], 'id'), '2');
  assert.equal(readBlocks(DOC, 'Ite').length, 0);
});

test('replaces only the first value, and says when there is none', () => {
  const xml = '<M><enabled>true</enabled><Region><enabled>true</enabled></Region></M>';
  assert.equal(
    replaceFirstTag(xml, 'enabled', 'false'),
    '<M><enabled>false</enabled><Region><enabled>true</enabled></Region></M>',
  );
  assert.equal(replaceFirstTag('<M/>', 'enabled', 'false'), null);
  assert.equal(readBoolean(xml, 'enabled'), true);
  assert.equal(readBoolean('<a>yes</a>', 'a'), undefined);
});
