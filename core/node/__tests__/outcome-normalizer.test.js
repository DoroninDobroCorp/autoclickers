const { normalize } = require('../llm/OutcomeNormalizer.js');

describe('OutcomeNormalizer', () => {
  test('normalizes decimal Russian under shorthand in basketball quarter totals', () => {
    const result = normalize(null, '1 четверть 56.5м', 'basketball');

    expect(result.intent).toBe('bet');
    expect(result.outcome).toEqual({
      original: '1 четверть 56.5м',
      canonical: 'Q1 T< 56.5'
    });
  });

  test('normalizes decimal Russian over shorthand in basketball quarter totals', () => {
    const result = normalize(null, '1 четверть 56,5б', 'basketball');

    expect(result.intent).toBe('bet');
    expect(result.outcome).toEqual({
      original: '1 четверть 56,5б',
      canonical: 'Q1 T> 56.5'
    });
  });

  test('normalizes Russian correct-score shorthand', () => {
    const result = normalize(null, '1:3 тс', 'soccer');

    expect(result.intent).toBe('bet');
    expect(result.outcome).toEqual({
      original: '1:3 тс',
      canonical: 'CS 1:3'
    });
  });

  test('extracts W1 from later line of a Telegram burst', () => {
    const result = normalize(null, 'Jordan (W)\n\nW1\n\nFootball\n\nFriendly International\n\nLive', 'soccer');

    expect(result.intent).toBe('bet');
    expect(result.outcome).toEqual({
      original: 'W1',
      canonical: '1'
    });
  });

  test('normalizes W2 shorthand', () => {
    const result = normalize(null, 'W2', 'soccer');

    expect(result.intent).toBe('bet');
    expect(result.outcome).toEqual({
      original: 'W2',
      canonical: '2'
    });
  });

  test('does not coerce unsupported nth-goal shorthand into team total', () => {
    const result = normalize(null, '3 гол 2 команда', 'soccer');

    expect(result.intent).toBe('unclear');
    expect(result.outcome).toBeNull();
  });

  test('normalizes spaced decimal total shorthand', () => {
    const result = normalize(null, 'тм 0 5', 'soccer');

    expect(result.intent).toBe('bet');
    expect(result.outcome).toEqual({
      original: 'тм 0 5',
      canonical: 'T< 0.5'
    });
  });

  test('normalizes Russian individual total shorthand with spaced decimal', () => {
    const result = normalize(null, 'ит2м 0 5', 'soccer');

    expect(result.intent).toBe('bet');
    expect(result.outcome).toEqual({
      original: 'ит2м 0 5',
      canonical: 'IT2< 0.5'
    });
  });

  test('normalizes Russian individual total over shorthand', () => {
    const result = normalize(null, 'ит1б1.5', 'soccer');

    expect(result.intent).toBe('bet');
    expect(result.outcome).toEqual({
      original: 'ит1б1.5',
      canonical: 'IT1> 1.5'
    });
  });
});
