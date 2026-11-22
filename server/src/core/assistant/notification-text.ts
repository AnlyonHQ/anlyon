export interface AdviceSummary {
  headline: string;
  reasons: string[];
}

export function adviceSummary(metadata: unknown): AdviceSummary | null {
  const advice = (metadata as { advice?: Record<string, unknown> } | null | undefined)?.advice;
  if (!advice || typeof advice !== "object" || typeof advice.recommendation !== "string") return null;
  const confidence = Number(advice.confidence);
  return {
    headline: `Vigil suggestion (not a decision): ${advice.recommendation} · risk ${String(advice.risk)} · confidence ${
      Number.isFinite(confidence) ? confidence.toFixed(2) : "n/a"
    }`,
    reasons: Array.isArray(advice.reasons) ? advice.reasons.slice(0, 3).map((reason) => String(reason)) : [],
  };
}
