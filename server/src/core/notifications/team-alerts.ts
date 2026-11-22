import { logger } from "../../lib/logger.ts";
import {
  createAndSendNotification,
  getNotificationPreferences,
  initializeNotificationPreferences,
  type CreateNotificationInput,
} from "./notification-service.ts";

export type TeamAlertType = "approval_expired" | "outcome_unknown" | "connection_broken";

export async function notifyTeamIfEnabled(input: CreateNotificationInput & { type: TeamAlertType }): Promise<boolean> {
  try {
    const prefs = (await getNotificationPreferences(input.workspaceId)) ?? (await initializeNotificationPreferences(input.workspaceId));
    if (!((prefs.enabledTypes as string[] | null) ?? []).includes(input.type)) return false;
    await createAndSendNotification(input);
    return true;
  } catch (error) {
    logger.warn({ workspaceId: input.workspaceId, type: input.type, error }, "Team alert could not be raised");
    return false;
  }
}
