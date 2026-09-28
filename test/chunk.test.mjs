// Unit tests for the markdown chunker (src/chunker.ts, compiled to lib/).
//
// The central invariant tested throughout: chunks.join('\n') === text for
// ANY input, including inputs containing lines longer than the limit (such
// lines own a chunk that may itself exceed the limit; no character-level
// splitting is ever performed).

import test from 'node:test';
import assert from 'node:assert/strict';

import { MessageChunker } from '../lib/chunker.js';

const X = 'x'.repeat(40);

test('non-string text throws TypeError', () => {
  assert.throws(() => new MessageChunker(100).chunk(123), TypeError);
  assert.throws(() => new MessageChunker(100).chunk(null), TypeError);
});

test('invalid limit throws RangeError', () => {
  assert.throws(() => new MessageChunker(Number.POSITIVE_INFINITY), RangeError);
  assert.throws(() => new MessageChunker(0), RangeError);
  assert.throws(() => new MessageChunker(-1), RangeError);
  assert.throws(() => new MessageChunker(NaN), RangeError);
});

test('empty string returns [""]', () => {
  assert.deepEqual(new MessageChunker(100).chunk(''), ['']);
});

test('text within (or exactly at) the limit returns the whole text unsplit', () => {
  const text = 'abc\ndef';
  assert.deepEqual(new MessageChunker(100).chunk(text), [text]);
  assert.deepEqual(new MessageChunker(text.length).chunk(text), [text]);
});

test('fence block that fits remaining capacity stays in one chunk', () => {
  // "```\nx\ny\n```" is 11 chars; with limit 15 it fits whole, unsplit.
  assert.deepEqual(new MessageChunker(15).chunk('```\nx\ny\n```'), ['```\nx\ny\n```']);
});

test('fence block larger than the limit is split line-wise inside the block, losing nothing', () => {
  // Block = "```\n" + x*40 + "\n```" = 48 chars > limit 10.
  const text = '```\n' + X + '\n```';
  const chunks = new MessageChunker(10).chunk(text);
  assert.deepEqual(chunks, ['```', X, '```']);
  assert.equal(chunks.join('\n'), text);
});

test('unterminated fence at EOF is treated as one block and still round-trips', () => {
  const text = '```\na\nb';
  const chunks = new MessageChunker(3).chunk(text);
  assert.deepEqual(chunks, ['```', 'a\nb']);
  assert.equal(chunks.join('\n'), text);
});

test('blank line inside the current chunk is the preferred split point (last blank wins)', () => {
  // "aa\n\nbb\nc\nd" (10 chars) > limit 7.
  // "aa" + "" fits; "bb" + "" + "bb" would overflow, so split at the blank
  // (kept at the end of the head chunk); tail "bb\nc" then "d" joins in.
  const chunks = new MessageChunker(7).chunk('aa\n\nbb\nc\nd');
  assert.deepEqual(chunks, ['aa\n', 'bb\nc\nd']);
  assert.equal(chunks.join('\n'), 'aa\n\nbb\nc\nd');
});

test('the blank-line split never cuts inside a fenced code block (last standalone blank wins)', () => {
  // The only blank lines live INSIDE the fence block; the last standalone
  // blank line is the one between "para one" and the fence, so the head
  // ends there and the fence block stays whole in the second chunk.
  const text = '# title\n\npara one\n\n```\ncode\n\nmore\n```\ntail';
  const chunks = new MessageChunker(40).chunk(text);
  assert.deepEqual(chunks, ['# title\n\npara one\n', '```\ncode\n\nmore\n```\ntail']);
  assert.equal(chunks.join('\n'), text);
  for (const c of chunks) {
    const fences = c.split('\n').filter((l) => l.trimStart().startsWith('```')).length;
    assert.ok(fences % 2 === 0, `fence block cut across chunks: ${JSON.stringify(c)}`);
  }
});

test('text shorter than the limit never splits, even when it contains a blank line', () => {
  // "a\n\nb\nc" is 6 chars <= 7, so the whole-text early return applies.
  assert.deepEqual(new MessageChunker(7).chunk('a\n\nb\nc'), ['a\n\nb\nc']);
});

test('hard split (no blank line available) is line-wise', () => {
  const chunks = new MessageChunker(7).chunk('abcd\nefgh\nijkl');
  assert.deepEqual(chunks, ['abcd', 'efgh', 'ijkl']);
  assert.equal(chunks.join('\n'), 'abcd\nefgh\nijkl');
});

test('a table block migrates atomically even across the limit', () => {
  // The table block (11 chars) fits the limit (12) but not together with
  // the preceding line, so it must move to the next chunk whole.
  const chunks = new MessageChunker(12).chunk('h\n|a|b|\n|c|d|');
  assert.deepEqual(chunks, ['h', '|a|b|\n|c|d|']);
  assert.equal(chunks.join('\n'), 'h\n|a|b|\n|c|d|');
});

test('a table block larger than the limit keeps its lines intact (over-limit chunk allowed)', () => {
  const text = 'h\n|ab|cd|';
  const chunks = new MessageChunker(6).chunk(text);
  assert.deepEqual(chunks, ['h', '|ab|cd|']);
  assert.equal(chunks.join('\n'), text);
});

test('a single over-limit line owns its chunk (chunk may exceed the limit)', () => {
  const text = 'ab\ncdefgh\nef';
  const chunks = new MessageChunker(5).chunk(text);
  assert.deepEqual(chunks, ['ab', 'cdefgh', 'ef']);
  assert.equal(chunks.join('\n'), text);
  assert.ok(chunks[1].length > 5); // documented: over-limit line owns an over-limit chunk
});

test('leading and trailing blank lines are preserved verbatim', () => {
  assert.deepEqual(new MessageChunker(3).chunk('\nab'), ['\nab']);
  assert.deepEqual(new MessageChunker(2).chunk('ab\n'), ['ab', '']);
});

test('round-trip identity on a deterministic pseudo-random mixed document', () => {
  // Deterministic PRNG (mulberry32) so this test is stable across runs.
  let seed = 0x5eed;
  const rand = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const limit = 37;
  const lines = [];
  for (let i = 0; i < 220; i++) {
    const r = rand();
    if (r < 0.12) {
      // occasional over-limit line (documented to own an over-limit chunk)
      lines.push('L'.repeat(40 + Math.floor(rand() * 80)));
    } else if (r < 0.22) {
      lines.push(''); // blank line
    } else if (r < 0.3 && lines.length > 0 && lines[lines.length - 1] !== '```') {
      // fence block, 2..7 content lines
      const fence = ['```'];
      const n = 2 + Math.floor(rand() * 6);
      for (let j = 0; j < n; j++) {
        fence.push('code line ' + Math.floor(rand() * 10000));
      }
      fence.push('```');
      for (const f of fence) {
        lines.push(f);
      }
    } else if (r < 0.38) {
      // table block, 2..4 rows
      const rows = Math.floor(rand() * 3) + 2;
      for (let j = 0; j < rows; j++) {
        lines.push(`|c${j}|v${Math.floor(rand() * 1000)}|`);
      }
    } else {
      lines.push('word '.repeat(Math.floor(rand() * 8)).trim() + ' ' + Math.floor(rand() * 1000));
    }
  }
  const text = lines.join('\n');

  const chunks = new MessageChunker(limit).chunk(text);
  assert.equal(chunks.join('\n'), text, 'round-trip identity must hold');

  // With over-limit lines present, over-limit chunks are expected and
  // allowed; every other chunk must fit the limit.
  if (!lines.some((l) => l.length > limit)) {
    for (const c of chunks) {
      assert.ok(c.length <= limit, `chunk unexpectedly over limit: ${c.length} > ${limit}`);
    }
  } else {
    // Over-limit chunks can only originate from over-limit lines: every such
    // chunk must contain at least one line longer than the limit.
    const over = chunks.filter((c) => c.length > limit);
    for (const c of over) {
      assert.ok(
        c.split('\n').some((l) => l.length > limit),
        `over-limit chunk must contain an over-limit line: ${c.length} > ${limit}`,
      );
    }
  }
});

test('round-trip identity on a document with no over-limit lines: all chunks fit the limit', () => {
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const limit = 30;
  const lines = [];
  for (let i = 0; i < 120; i++) {
    const r = rand();
    if (r < 0.15) {
      lines.push('');
    } else if (r < 0.3) {
      lines.push('```');
      lines.push('short code');
      lines.push('```');
    } else if (r < 0.4) {
      lines.push('|a|b|');
      lines.push('|c|d|');
    } else {
      lines.push('plain line ' + i + ' ' + Math.floor(rand() * 1000));
    }
  }
  const text = lines.join('\n');
  const chunks = new MessageChunker(limit).chunk(text);
  assert.equal(chunks.join('\n'), text);
  for (const c of chunks) {
    assert.ok(c.length <= limit, `chunk unexpectedly over limit: ${c.length} > ${limit}`);
    // every fence here fits the limit, so no fence may be line-split
    const fences = c.split('\n').filter((l) => l.trimStart().startsWith('```')).length;
    assert.ok(fences % 2 === 0, `fence block cut across chunks: ${JSON.stringify(c)}`);
  }
});

test('round-trip + fence integrity on a document with blank lines inside fenced blocks', () => {
  let seed = 1337;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const limit = 30;
  const lines = [];
  for (let i = 0; i < 160; i++) {
    const r = rand();
    if (r < 0.15) {
      lines.push('');
    } else if (r < 0.35) {
      // small fence block, sometimes containing blank lines INSIDE the block
      lines.push('```');
      const n = 1 + Math.floor(rand() * 3);
      for (let j = 0; j < n; j++) {
        lines.push(rand() < 0.3 ? '' : 'c' + Math.floor(rand() * 10));
      }
      lines.push('```');
    } else if (r < 0.45) {
      lines.push('|a|b|');
      lines.push('|c|d|');
    } else {
      lines.push('plain line ' + i + ' ' + Math.floor(rand() * 1000));
    }
  }
  const text = lines.join('\n');
  const chunks = new MessageChunker(limit).chunk(text);
  assert.equal(chunks.join('\n'), text, 'round-trip identity must hold');
  for (const c of chunks) {
    assert.ok(c.length <= limit, `chunk unexpectedly over limit: ${c.length} > ${limit}`);
    const fences = c.split('\n').filter((l) => l.trimStart().startsWith('```')).length;
    assert.ok(fences % 2 === 0, `fence block cut across chunks: ${JSON.stringify(c)}`);
  }
});
