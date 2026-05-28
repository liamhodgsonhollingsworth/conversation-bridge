// Tiny uuid v4 generator. crypto.randomUUID is widely available but we keep a fallback.

export function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // RFC4122-shaped fallback. Not cryptographically strong but fine as a connection id.
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      out += '-';
    } else if (i === 14) {
      out += '4';
    } else if (i === 19) {
      out += hex[(Math.random() * 4) | (0 + 8)];
    } else {
      out += hex[(Math.random() * 16) | 0];
    }
  }
  return out;
}
