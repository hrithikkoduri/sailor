/** Pure textarea edit; null means the insert would exceed the character cap. */
export function insertAtSelection(
  value: string,
  start: number,
  end: number,
  insert: string,
  maxLength = Number.POSITIVE_INFINITY,
): { value: string; caret: number } | null {
  if (value.length - (end - start) + insert.length > maxLength) return null;
  return {
    value: value.slice(0, start) + insert + value.slice(end),
    caret: start + insert.length,
  };
}
