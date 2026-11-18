/**
 * Drops trailing characters in a single pass. A regex like /\/+$/ backtracks
 * on long runs and takes quadratic time on a long request value.
 */
export function trimEnd(value: string, chars = "/"): string {
  let end = value.length;
  while (end > 0 && chars.includes(value[end - 1])) end--;
  return value.slice(0, end);
}

export function trimStart(value: string, chars = "/"): string {
  let start = 0;
  while (start < value.length && chars.includes(value[start])) start++;
  return value.slice(start);
}
