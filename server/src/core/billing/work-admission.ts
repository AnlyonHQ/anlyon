export interface WorkAdmission {
  expensiveWorkPaused(): boolean;
  modelCallsPaused(): boolean;
}

let admission: WorkAdmission | null = null;

export function setWorkAdmission(next: WorkAdmission): void {
  if (admission && admission !== next) throw new Error("A work admission brake is already registered");
  admission = next;
}

export function resetWorkAdmission(): void {
  admission = null;
}

export function expensiveWorkPaused(): boolean {
  return admission?.expensiveWorkPaused() ?? false;
}

export function modelCallsPaused(): boolean {
  return admission?.modelCallsPaused() ?? false;
}
