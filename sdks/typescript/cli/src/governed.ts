import type { ActionImpactDeclaration, ActionVerifyDeclaration, EffectGrade } from '@anlyonhq/sdk';

/** Every receipt grade, with what it tells the reader. Shown in `effects get`. */
export const GRADE_MEANINGS: Record<EffectGrade, string> = {
  confirmed: 'A read-back matched the request.',
  acknowledged: 'The provider accepted the request. Nothing read it back.',
  unknown: 'No usable response. Anlyon does not send it again. It stays unknown until a read-back or an operator settles it.',
  failed: 'The provider rejected the request, or it never left Anlyon.',
  refused: 'Anlyon refused it at dispatch.',
  denied: 'The approval was denied.',
  pending: 'No receipt yet.',
};

export const GRADES = Object.keys(GRADE_MEANINGS) as EffectGrade[];

/** "confirmed: A read-back matched the request." A grade this build does not know prints as it came. */
export function describeGrade(grade: unknown): unknown {
  const meaning = typeof grade === 'string' ? (GRADE_MEANINGS as Record<string, string | undefined>)[grade] : undefined;
  return meaning ? `${grade}: ${meaning}` : grade;
}

/** "emails: count(input.to), exact" or "money (usd): input.amount, upper_bound". */
export function describeImpact(impact: unknown): string | undefined {
  if (!impact || typeof impact !== 'object') return undefined;
  const { dimension, unit, amount, bound } = impact as Partial<ActionImpactDeclaration>;
  return `${dimension}${unit && unit !== dimension ? ` (${unit})` : ''}: ${amount}, ${bound}`;
}

/** "GET <url> must answer 200, data.status = "sent"". */
export function describeVerify(verify: unknown): string | undefined {
  if (!verify || typeof verify !== 'object') return undefined;
  const { url, status, match } = verify as Partial<ActionVerifyDeclaration>;
  const checks = (match ?? []).map((check) => `, ${check.path} ${check.absent ? '!=' : '='} ${JSON.stringify(check.equals)}`).join('');
  return `GET ${url} must answer ${status}${checks}`;
}
