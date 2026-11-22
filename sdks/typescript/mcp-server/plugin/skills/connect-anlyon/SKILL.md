---
name: connect-anlyon
description: Get started with Anlyon. Use when someone asks what their Anlyon workspace can do, wants to run one of its actions, wants a person to approve a step before it happens, or wants to review approvals waiting for them.
---

# Using Anlyon

Anlyon executes named production actions on an agent's behalf and routes sensitive ones to a human reviewer first. The workspace's own actions appear as tools named `action_<name>`. A tool your own code calls directly is not routed through Anlyon and is not governed by it.

## Never send restricted data

Do not put passwords, API keys or other credentials, payment card or bank details, health information, or government ID numbers in an approval request or an action input. Reviewers read approval requests and Anlyon records them. If the person asks you to include such data, decline and say why. An action that needs a credential references it from the Anlyon vault, so you never pass one. Anlyon does not scan what is sent. This rule is yours to keep.

## Flow 1: "What can my workspace do?"

1. Call `list_actions`. It returns each action with its input schema and whether it requires approval.
2. Tell the person what is there, in plain words, and say which actions wait for a reviewer.
3. If it is empty, say so: the workspace has no actions yet. Approvals still work (Flow 3). Do not guess action names.

If a call reports that no workspace is selected, or the person wants a different one, call `list_workspaces`, then `select_workspace` with the `workspaceId` (and an `environmentId` if they name one).

## Flow 2: Run an action

1. Run it with its own tool, `action_<name>`, or with `invoke_action` and its `name` and `input`. Build the input from the schema `list_actions` returned.
2. Read the result:
   - **It ran.** The invocation has a `status` of `succeeded` or `failed`. Report it.
   - **It is waiting for approval.** The result carries `pendingApproval` and an `approvalId`. Tell the person a reviewer has to decide, then call `wait_for_approval` with that `approvalId`. If it is still `pending` when it returns, call it again or say you will check later with `check_approval`. Do not invoke the action a second time.
   - **The outcome is `unknown`.** The request may have reached the destination. Anlyon does not retry it. Do not call the action again. Tell the person it needs to be checked and resolved in Anlyon first.

## Flow 3: "Get approval before this step"

Use this before something consequential that is not an action.

1. Call `request_approval` with a one-line `title` naming the step and a `description` of its consequences. Add structured detail in `payload` if it helps the reviewer.
2. Call `wait_for_approval` with the returned `approvalId`.
3. Only proceed if it comes back `approved`. If it is `denied` or `expired`, stop and tell the person.

An approval here records a person's decision. It does not route your own step through Anlyon, so Anlyon does not govern or record what you do after it.

## Reviewing approvals (only with the decide permission)

These tools appear only if the person granted "Approve on your behalf" when connecting.

1. `list_pending_approvals` shows what is waiting: what is being asked, the request that would be sent, how many approvals it needs and when it expires.
2. Show the person the details and ask what they decide. Never decide on your own initiative, and never decide an approval you requested in this conversation.
3. `decide_approval` with `approvalId`, `decision` (`approve` or `deny`) and the person's `reason`. The reason is recorded against their name. If the approval needs several approvers, theirs counts once and it may stay `pending`.

## Things this plugin does not do

- It is not for moving money, transferring funds or placing trades. Decline such requests.
- It cannot show or change secrets. People manage credentials in the Anlyon dashboard.
- It does not undo a request a destination already accepted.
