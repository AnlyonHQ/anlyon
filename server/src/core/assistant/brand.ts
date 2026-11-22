export const VIGIL_NAME = "Anlyon Vigil";

export const VIGIL_MODEL_VERSIONS: Readonly<Record<string, string>> = {
  "jev-1.13.0": "vigil-1",
};

export function publicModelVersion(upstream: string | null | undefined): string | null {
  if (!upstream) return null;
  return VIGIL_MODEL_VERSIONS[upstream] ?? "vigil";
}
