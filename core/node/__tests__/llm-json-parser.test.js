const {
  stripCodeFences,
  extractBalancedJson,
  repairJsonText,
  parseModelJsonResponse
} = require('../telegram/llm-json-parser.js');

describe('llm-json-parser', () => {
  test('should strip fenced json payloads', () => {
    expect(stripCodeFences('```json\n{"ok":true}\n```')).toBe('{"ok":true}');
  });

  test('should extract a balanced json object from surrounding text', () => {
    expect(extractBalancedJson('prefix {"ok":true,"nested":{"a":1}} suffix')).toBe('{"ok":true,"nested":{"a":1}}');
  });

  test('should repair raw newlines inside json strings', () => {
    const malformed = '{\n  "notes": "line 1\nline 2",\n  "queueDecision": "hold"\n}';
    const parsed = parseModelJsonResponse(malformed);
    expect(parsed).toEqual({
      notes: 'line 1\nline 2',
      queueDecision: 'hold'
    });
  });

  test('should repair unescaped quotes inside json strings', () => {
    const malformed = '{\n  "notes": "market says "live total" on screenshot",\n  "queueDecision": "enqueue"\n}';
    const repaired = repairJsonText(malformed);
    const parsed = parseModelJsonResponse(repaired);
    expect(parsed.notes).toContain('"live total"');
    expect(parsed.queueDecision).toBe('enqueue');
  });
});
