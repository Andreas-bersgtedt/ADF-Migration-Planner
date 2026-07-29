export function utcNow(): string {
  return new Date().toISOString();
}

export function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
