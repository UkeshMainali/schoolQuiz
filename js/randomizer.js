// Randomisation for each new attempt. The result is saved with the attempt,
// so the order never changes while a student moves back and forth or reloads.

function randomInt(maxExclusive) {
  if (window.crypto?.getRandomValues) {
    const buf = new Uint32Array(1);
    // Rejection sampling avoids modulo bias.
    const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
    do { window.crypto.getRandomValues(buf); } while (buf[0] >= limit);
    return buf[0] % maxExclusive;
  }
  return Math.floor(Math.random() * maxExclusive);
}

/** Fisher–Yates shuffle; returns a new array. */
export function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Builds a random question order and an independent option order for every
 * question, using stable ids (never display letters).
 *   order:       ["L1-Q003", "L1-Q001", ...]
 *   optionOrder: { "L1-Q001": ["C", "A", "D", "B"], "L1-Q003": [] }
 */
export function buildRandomOrder(quiz) {
  const order = shuffle(quiz.questions.map((q) => q.id));
  const optionOrder = {};
  quiz.questions.forEach((q) => {
    optionOrder[q.id] = Array.isArray(q.options) ? shuffle(q.options.map((o) => o.id)) : [];
  });
  return { order, optionOrder };
}
