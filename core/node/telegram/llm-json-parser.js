function stripCodeFences(text = '') {
  return String(text)
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

function nextNonWhitespace(text, startIndex) {
  for (let i = startIndex; i < text.length; i += 1) {
    if (!/\s/.test(text[i])) {
      return text[i];
    }
  }
  return null;
}

function extractBalancedJson(text = '') {
  const source = String(text || '');
  let startIndex = -1;
  let inString = false;
  let escapeNext = false;
  const stack = [];

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (startIndex === -1) {
      if (ch === '{' || ch === '[') {
        startIndex = i;
        stack.push(ch);
      }
      continue;
    }

    if (inString) {
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (ch === '\\') {
        escapeNext = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{' || ch === '[') {
      stack.push(ch);
      continue;
    }

    if (ch === '}' || ch === ']') {
      const last = stack[stack.length - 1];
      if ((ch === '}' && last === '{') || (ch === ']' && last === '[')) {
        stack.pop();
        if (stack.length === 0) {
          return source.slice(startIndex, i + 1);
        }
      }
    }
  }

  if (startIndex !== -1) {
    return source.slice(startIndex).trim();
  }
  return source.trim();
}

function removeTrailingCommas(text = '') {
  let output = String(text || '');
  let previous;
  do {
    previous = output;
    output = output.replace(/,\s*([}\]])/g, '$1');
  } while (output !== previous);
  return output;
}

function repairJsonText(text = '') {
  const normalized = String(text || '')
    .replace(/\u201c|\u201d/g, '"')
    .replace(/\u2018|\u2019/g, "'");

  let inString = false;
  let escapeNext = false;
  const stack = [];
  let output = '';

  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];

    if (!inString) {
      if (ch === '"') {
        inString = true;
        output += '"';
        continue;
      }

      if (ch === '{' || ch === '[') {
        stack.push(ch);
      } else if (ch === '}' || ch === ']') {
        const last = stack[stack.length - 1];
        if ((ch === '}' && last === '{') || (ch === ']' && last === '[')) {
          stack.pop();
        }
      }

      output += ch;
      continue;
    }

    if (escapeNext) {
      output += ch;
      escapeNext = false;
      continue;
    }

    if (ch === '\\') {
      output += ch;
      escapeNext = true;
      continue;
    }

    if (ch === '"') {
      const next = nextNonWhitespace(normalized, i + 1);
      if (next === null || next === ',' || next === '}' || next === ']' || next === ':') {
        inString = false;
        output += '"';
      } else {
        output += '\\"';
      }
      continue;
    }

    if (ch === '\n') {
      output += '\\n';
      continue;
    }

    if (ch === '\r') {
      output += '\\r';
      continue;
    }

    if (ch === '\t') {
      output += '\\t';
      continue;
    }

    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      output += `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }

    output += ch;
  }

  if (inString) {
    output += '"';
  }

  while (stack.length > 0) {
    const open = stack.pop();
    output += open === '{' ? '}' : ']';
  }

  return removeTrailingCommas(output.trim());
}

function tryParseJson(text) {
  return JSON.parse(text);
}

function parseModelJsonResponse(responseText, options = {}) {
  const logger = options.logger || null;
  const raw = String(responseText || '').trim();
  const stripped = stripCodeFences(raw);
  const extracted = extractBalancedJson(stripped);
  const repaired = repairJsonText(extracted);
  const candidates = [];

  for (const candidate of [raw, stripped, extracted, repaired]) {
    const normalized = String(candidate || '').trim();
    if (!normalized || candidates.includes(normalized)) continue;
    candidates.push(normalized);
  }

  let lastError = null;
  for (let i = 0; i < candidates.length; i += 1) {
    try {
      const parsed = tryParseJson(candidates[i]);
      if (i > 0 && logger?.log) {
        logger.log(`⚠️ Repaired LLM JSON response using fallback parser (strategy ${i + 1}/${candidates.length})`);
      }
      return parsed;
    } catch (error) {
      lastError = error;
    }
  }

  const preview = raw.slice(0, 400).replace(/\s+/g, ' ');
  throw new Error(`Failed to parse model JSON: ${lastError?.message || 'unknown error'} | Preview: ${preview}`);
}

module.exports = {
  stripCodeFences,
  extractBalancedJson,
  repairJsonText,
  parseModelJsonResponse
};
