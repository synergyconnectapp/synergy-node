// The methods take camelCase and speak snake_case on the wire; answers the SDK models come back camelCase (the raw body
// stays in `raw`). Only plain `snake_case` keys are touched: values are never rewritten.
const camelKey = (k: string) => k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

export function camelize<T = unknown>(value: unknown): T {
  if (Array.isArray(value)) return value.map((v) => camelize(v)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [camelKey(k), camelize(v)])) as T;
  }
  return value as T;
}
