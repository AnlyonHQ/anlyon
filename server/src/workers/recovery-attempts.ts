export const MAX_RECOVERY_DELIVERIES = 10;
export const RECOVERY_DELIVERIES_FIELD = "recoveryDeliveries";

export function nextRecoveryAttempt(
  fields: readonly string[],
  deliveryCount: number,
): { totalDeliveries: number; requeueFields: string[] } {
  const requeueFields: string[] = [];
  let previous = 0;
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i] === RECOVERY_DELIVERIES_FIELD) {
      const parsed = Number.parseInt(fields[i + 1], 10);
      previous = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
      continue;
    }
    requeueFields.push(fields[i], fields[i + 1]);
  }
  const totalDeliveries = previous + Math.max(deliveryCount, 1);
  requeueFields.push(RECOVERY_DELIVERIES_FIELD, String(totalDeliveries));
  return { totalDeliveries, requeueFields };
}
