import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** RFC 7636: 32 random bytes → a 43-character verifier; S256 challenge. */
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: challengeFor(verifier) };
}

export function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function createState(): string {
  return randomBytes(32).toString('base64url');
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
