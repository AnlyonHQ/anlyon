/**
 * Tool descriptions for ChatGPT.
 *
 * The default descriptions are written for a developer's agent and stay so for
 * every other client. ChatGPT's users are people in a conversation, and the
 * plugin guidelines ask tools that store data to keep restricted data out of
 * it, so this overlay rewrites the descriptions ChatGPT reads. Tools not named
 * here keep their default description.
 */

/**
 * Said on every tool that stores what the user tells it. No tool in the default or ChatGPT
 * presentation stores user content since version 3 removed the memory and session tools; the
 * constant stays exported for hosts that add their own.
 */
export const RESTRICTED_DATA_WARNING =
  'Never store passwords, API keys or other credentials, payment card or bank details, health information, or government ID numbers such as passport or social security numbers. If the user asks you to, decline and say why.';

export const DESCRIPTION_OVERLAYS: Readonly<Record<string, string>> = {
  list_actions:
    "List the actions the user's Anlyon workspace has defined and which ones need a person to approve them first.",
  invoke_action:
    'Run one of the workspace\'s actions by name. Anlyon makes the request with credentials it holds. You never see them. If the action needs approval, it waits for a reviewer and you get an approval id. If the outcome is unknown, do not run it again.',
  list_pending_approvals: 'Show the approvals waiting for a decision, with what each would do.',
  decide_approval:
    'Approve or deny a pending approval, with the reason the user gives. Only decide what the user has explicitly told you to decide. Approving a gated action runs the request once enough approvers agree.',
};

export function overlayDescription(name: string, description: string): string {
  return DESCRIPTION_OVERLAYS[name] ?? description;
}
