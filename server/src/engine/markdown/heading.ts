const SPACE_RE = /\s/;
// The characters `.` does not match in a regular expression.
const LINE_TERMINATORS = new Set([
  "\n",
  "\r",
  String.fromCharCode(0x20_28),
  String.fromCharCode(0x20_29),
]);

function isSpace(char: string | undefined): boolean {
  return char !== undefined && SPACE_RE.test(char);
}

function hasLineTerminator(text: string): boolean {
  for (const char of text) {
    if (LINE_TERMINATORS.has(char)) {
      return true;
    }
  }
  return false;
}

/**
 * Where the content of a heading body ends: the body with its longest tail of
 * the form whitespace, hashes, whitespace (the optional closing hashes) cut
 * off. Scanning back from the end keeps this linear.
 */
function contentEnd(body: string): number {
  let end = body.length;
  while (end > 0 && isSpace(body[end - 1])) {
    end -= 1;
  }
  while (end > 0 && body[end - 1] === "#") {
    end -= 1;
  }
  while (end > 0 && isSpace(body[end - 1])) {
    end -= 1;
  }
  return end;
}

/**
 * A line of nothing but hashes and whitespace. The pattern this replaces lets
 * the whitespace before the "text" shrink until one character is left to be
 * the text, so the last usable whitespace character after the first one is it.
 */
function whitespaceOnlyText(whitespace: string): string | null {
  for (let index = whitespace.length - 1; index >= 1; index -= 1) {
    const char = whitespace[index];
    if (char !== undefined && !LINE_TERMINATORS.has(char)) {
      return char;
    }
  }
  return null;
}

/**
 * The text of an ATX heading written with `min` to `max` hashes, or null when
 * the line is not one. It returns exactly what group 1 of
 * `/^#{min,max}\s+(.+?)\s*#*\s*$/` captures, without that pattern's
 * backtracking: `\s*#*\s*$` after a lazy `.+?` takes time cubic in the length
 * of a line with a long run of spaces in it, and the FAQ parser runs this on
 * every line of every article that is saved or rendered.
 */
export function headingText(
  line: string,
  min: number,
  max: number
): string | null {
  let hashes = 0;
  while (line[hashes] === "#") {
    hashes += 1;
  }
  if (hashes < min || hashes > max) {
    return null;
  }
  let bodyStart = hashes;
  while (isSpace(line[bodyStart])) {
    bodyStart += 1;
  }
  if (bodyStart === hashes) {
    return null;
  }
  if (bodyStart === line.length) {
    return whitespaceOnlyText(line.slice(hashes));
  }
  const body = line.slice(bodyStart);
  // The text is at least one character, even when all of the body would pass
  // for closing hashes ("## ###" is the heading "#").
  const text = body.slice(0, Math.max(1, contentEnd(body)));
  return hasLineTerminator(text) ? null : text;
}
