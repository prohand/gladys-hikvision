// -----------------------------------------------------------------------------
// The little XML the ISAPI needs.
//
// Hikvision answers in flat, predictable XML (one default namespace, no
// prefixes, no CDATA in the documents read here). A full parser would be a
// dependency for nothing: these helpers read a tag, list repeated blocks and
// rewrite one value, and every caller tolerates a missing tag.
// -----------------------------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decode the five XML entities and the numeric references. */
export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code =
        name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** Escape a value written into an XML document. */
export function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeName(name) {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Text of the first `<name>` element, trimmed and decoded; undefined when absent.
 * @param {string} xml document or fragment
 * @param {string} name tag name, without namespace
 */
export function readTag(xml, name) {
  const match = new RegExp(`<${escapeName(name)}(?:\\s[^>]*)?>([^<]*)</${escapeName(name)}>`).exec(
    xml ?? '',
  );
  return match ? decodeEntities(match[1]).trim() : undefined;
}

/**
 * Inner XML of every `<name>` element (not nested in one another).
 * @param {string} xml document
 * @param {string} name tag name of the repeated block
 * @returns {string[]}
 */
export function readBlocks(xml, name) {
  const pattern = new RegExp(
    `<${escapeName(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escapeName(name)}>`,
    'g',
  );
  return [...(xml ?? '').matchAll(pattern)].map((match) => match[1]);
}

/**
 * The document with the text of its first `<name>` element replaced.
 * @param {string} xml document
 * @param {string} name tag name
 * @param {string} value new text (escaped here)
 * @returns {string | null} null when the tag is absent
 */
export function replaceFirstTag(xml, name, value) {
  const pattern = new RegExp(`(<${escapeName(name)}(?:\\s[^>]*)?>)[^<]*(</${escapeName(name)}>)`);
  if (!pattern.test(xml)) {
    return null;
  }
  return xml.replace(pattern, (_whole, open, close) => `${open}${escapeXml(value)}${close}`);
}

/** `true` / `false` as Hikvision writes them; undefined for anything else. */
export function readBoolean(xml, name) {
  const text = readTag(xml, name)?.toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  return undefined;
}
