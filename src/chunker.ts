/**
 * Line/token-aware markdown chunking for QQ proactive sends.
 *
 * Design goals (platform constraint: one QQ message body <= `limit` chars):
 *   1. Round-trip: for EVERY input, chunks.join('\n') === text. No
 *      character is ever lost or added. The platform receives each chunk
 *      verbatim; joining is a caller-side concern only.
 *   2. Structure preservation: fenced code blocks and tables are atomic
 *      tokens; they migrate whole between chunks when they do not fit the
 *      remaining budget, and a fence block larger than the limit is split
 *      line-wise inside the block (losing nothing). No line is ever split
 *      in the middle of the line.
 *   3. Preferred split point: the last blank line of the current chunk (only
 *      blank lines that are tokens of their own count; blank lines inside a
 *      fenced code block belong to the fence token and are never split
 *      points), so paragraphs stay intact when the budget allows it and a
 *      fenced block is never cut in the middle by this rule.
 *   4. Oversized lines: a single line longer than `limit` cannot be split
 *      without breaking the round-trip guarantee, so a single line longer
 *      than `limit` simply owns a chunk by itself and that chunk may exceed
 *      `limit`; the platform truncates or rejects it, which is the
 *      intended, documented behavior.
 *
 * The `MessageChunker` is constructed with the platform message-size cap in
 * characters and reused for every send; the constructor rejects a limit
 * that is not a positive finite number (RangeError), so a misconfigured
 * limit fails at construction instead of at the first chunk call.
 */

type TokenKind = 'fence' | 'table' | 'line';

interface Token {
  kind: TokenKind;
  value: string;
  /** value.length, computed once at tokenization time. */
  length: number;
}

export class MessageChunker {
  private readonly limit: number;

  /**
   * @throws RangeError when `limit` is not a positive finite number
   */
  constructor(limit: number) {
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new RangeError(`MessageChunker: limit must be a positive finite number, got ${String(limit)}`);
    }
    this.limit = limit;
  }

  /**
   * Split markdown `text` into chunks of at most this chunker's limit
   * characters, preserving structure as far as possible.
   * @throws TypeError when `text` is not a string
   */
  chunk(text: string): string[] {
    if (typeof text !== 'string') {
      throw new TypeError('MessageChunker.chunk: text must be a string');
    }
    const limit = this.limit;
    if (text.length <= limit) {
      return [text];
    }

    const tokens = this.tokenizeLines(text.split('\n'));

    const chunks: string[] = [];
    let pending: Token[] | null = null;
    let pendingLen = 0;

    for (const token of tokens) {
      // An oversized token (a fence or table block taller than the limit) is
      // re-packed line-wise straight into the output: no character is lost,
      // and lines longer than the limit own their own chunk.
      if (token.length > limit) {
        if (pending !== null) {
          chunks.push(pending.map((t) => t.value).join('\n'));
          pending = null;
          pendingLen = 0;
        }
        this.packLines(token.value.split('\n'), chunks);
        continue;
      }
      if (pending === null) {
        pending = [token];
        pendingLen = token.length;
        continue;
      }
      if (pendingLen + 1 + token.length <= limit) {
        pending.push(token);
        pendingLen += 1 + token.length;
        continue;
      }
      // Overflow. A chunk can be split at its last standalone blank line when
      // the tail still fits; otherwise (no such blank line, tail too large, or
      // an atomic fence/table token) the current chunk is flushed whole and
      // the incoming token starts the next chunk.
      const splitPoint: { head: string; tail: Token[]; tailLen: number } | null =
        token.kind === 'line' ? this.splitAtLastBlank(pending, token.value) : null;
      if (splitPoint !== null) {
        chunks.push(splitPoint.head);
        pending = splitPoint.tail;
        pendingLen = splitPoint.tailLen;
      } else {
        chunks.push(pending.map((t) => t.value).join('\n'));
        pending = [token];
        pendingLen = token.length;
      }
    }
    if (pending !== null) {
      chunks.push(pending.map((t) => t.value).join('\n'));
    }

    return chunks;
  }

  /**
   * Tokenize the lines of `text` into plain lines, fenced code blocks
   * (including their fence lines) and table row runs. A fence starts at the
   * first line whose trimmed form starts with ``` and ends at the next such
   * line; an unterminated fence at EOF swallows the remainder.
   */
  private tokenizeLines(lines: string[]): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.trimStart().startsWith('```')) {
        // fence block: from this fence line to the closing fence line (both
        // included), or to EOF when the fence is unterminated
        let j = i + 1;
        while (j < lines.length && !lines[j].trimStart().startsWith('```')) {
          j++;
        }
        const end = j < lines.length ? j : lines.length - 1;
        tokens.push({ kind: 'fence', value: lines.slice(i, end + 1).join('\n'), length: 0 });
        i = end + 1;
        continue;
      }
      if (/^\|.+\|$/.test(line)) {
        // table block: consecutive lines that look like markdown table rows
        let j = i;
        while (j < lines.length && /^\|.+\|$/.test(lines[j])) {
          j++;
        }
        tokens.push({ kind: 'table', value: lines.slice(i, j).join('\n'), length: 0 });
        i = j;
        continue;
      }
      tokens.push({ kind: 'line', value: line, length: line.length });
      i++;
    }
    // multi-line tokens: their length is the joined length (newlines included)
    for (const token of tokens) {
      if (token.length === 0) {
        token.length = token.value.length;
      }
    }
    return tokens;
  }

  /**
   * Greedily re-pack `lines` into chunks of at most this chunker's limit
   * characters, joined with single newlines and appended to `out`. A line
   * longer than the limit becomes its own chunk (round-trip preserved; the
   * chunk may exceed the limit).
   */
  private packLines(lines: string[], out: string[]): void {
    const limit = this.limit;
    let current: string | null = null;
    for (const line of lines) {
      if (line.length > limit) {
        if (current !== null) {
          out.push(current);
          current = null;
        }
        out.push(line);
        continue;
      }
      if (current === null) {
        current = line;
        continue;
      }
      if (current.length + 1 + line.length <= limit) {
        current += `\n${line}`;
        continue;
      }
      out.push(current);
      current = line;
    }
    if (current !== null) {
      out.push(current);
    }
  }

  /**
   * Split the in-progress chunk `current` (token list) before `line` so the
   * tail still fits within this chunker's limit. The last standalone blank
   * line of `current` is the preferred split point: the head keeps
   * everything up to and including it, the tail is the remaining tokens plus
   * `line`, and the tail is accepted only when it fits the limit. Only blank
   * lines that are tokens of their own count; a blank line inside a fenced
   * code block belongs to the fence token and can never be a split point, so
   * this rule never cuts a fence block in the middle.
   * @returns the head string plus the tail token list, or null when no valid
   *          split exists (the caller then flushes the current chunk whole)
   */
  private splitAtLastBlank(
    current: Token[],
    line: string,
  ): { head: string; tail: Token[]; tailLen: number } | null {
    const limit = this.limit;
    // index of the last standalone blank line, counting from the end
    let lastBlank = -1;
    for (let i = current.length - 1; i >= 0; i--) {
      if (current[i].kind === 'line' && current[i].value.length === 0) {
        lastBlank = i;
        break;
      }
    }
    if (lastBlank < 0) {
      return null;
    }
    const head = current.slice(0, lastBlank + 1).map((t) => t.value).join('\n');
    const tail: Token[] = [
      ...current.slice(lastBlank + 1),
      { kind: 'line', value: line, length: line.length },
    ];
    const tailLen = tail.reduce((acc, t) => acc + t.length, 0) + tail.length - 1;
    if (tailLen > limit) {
      return null;
    }
    return { head, tail, tailLen };
  }
}
