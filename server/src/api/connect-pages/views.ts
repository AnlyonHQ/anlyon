import type { ConnectPageField, ConnectPageView } from "./render.ts";

type Integration = { id: string; name: string };

const backToApp = (app: string) => `Go back to ${app}'s app and start again.`;
const BACK = "Go back to the app you came from and start again.";

export function linkView(input: { integration: Integration; app: string; continueHref: string; cancelHref: string | null }): ConnectPageView {
  const { integration, app } = input;
  const i = integration.name;
  return {
    status: 200,
    heading: `Connect ${i} to ${app}`,
    lead: `${app} is asking to act in your ${i} account.`,
    hero: { kind: "pair", integration, app },
    facts: [
      { icon: "lock", text: `You sign in at ${i}, not here.` },
      { icon: "info", text: `${i} will show Anlyon, which connects your account for ${app}.` },
      { icon: "eye-off", text: `${app} never sees your password.` },
      { icon: "unlink", text: `You can disconnect it in ${app}'s app at any time.` },
    ],
    caution: `Continue if you started this in ${app}'s app. If you did not, close this page.`,
    primary: { href: input.continueHref, label: `Continue to ${i}` },
    ...(input.cancelHref ? { secondary: { href: input.cancelHref, label: "Cancel and go back" } } : {}),
  };
}

export function keyFormView(input: {
  integration: Integration;
  app: string;
  token: string;
  action: string;
  fields: ConnectPageField[];
  help?: { text: string; href?: string };
  cancelHref: string | null;
  redirectOrigin: string | null;
  refused?: { message: string; attemptsLeft: number };
  destination?: { host: string | null };
}): ConnectPageView {
  const { integration, app, refused, destination } = input;
  const i = integration.name;
  const where = destination?.host ?? "a server it chose";
  return {
    status: refused ? 400 : 200,
    heading: `Connect ${i} to ${app}`,
    lead: destination
      ? `${app} is asking for your key for ${i}, a server at ${where}, so it can act in your account. Check that this is where your key belongs.`
      : `${app} is asking for your ${i} key so it can act in your account.`,
    hero: { kind: "pair", integration, app },
    ...(refused
      ? { alert: { title: refused.message, detail: `Nothing was stored. ${refused.attemptsLeft === 1 ? "One try is" : `${refused.attemptsLeft} tries are`} left on this link.` } }
      : {
        facts: destination
          ? [
            { icon: "shield" as const, text: `Your key is sent to ${destination.host ?? "that server"}, the server ${app} chose, to check it before it is saved.` },
            { icon: "lock" as const, text: `Anlyon stores it encrypted, never shows it again, and sends it only to ${destination.host ?? "that server"}.` },
            { icon: "unlink" as const, text: `You can disconnect it in ${app}'s app at any time.` },
          ]
          : [
            { icon: "shield" as const, text: `Your key is checked with ${i} before it is saved.` },
            { icon: "lock" as const, text: `It is stored encrypted and never shown again. ${app} never sees it.` },
            { icon: "unlink" as const, text: `You can disconnect it in ${app}'s app at any time.` },
          ],
      }),
    form: { action: input.action, token: input.token, fields: input.fields, submit: `Connect ${i}`, ...(input.help ? { help: input.help } : {}) },
    caution: `Continue if you started this in ${app}'s app. If you did not, close this page.`,
    ...(input.cancelHref ? { secondary: { href: input.cancelHref, label: "Cancel and go back" } } : {}),
    formTargets: input.redirectOrigin ? [input.redirectOrigin] : [],
  };
}

export function keyUsedUpView(input: { integration: Integration; app: string; message: string; backHref: string | null }): ConnectPageView {
  return {
    status: 400,
    heading: `${input.integration.name} did not accept the key`,
    lead: `${input.message} Nothing was stored, and this link has no tries left. ${backToApp(input.app)}`,
    hero: { kind: "status", tone: "error", icon: "alert" },
    ...(input.backHref ? { secondary: { href: input.backHref, label: "Go back" } } : {}),
  };
}

export const expiredLinkView = (): ConnectPageView => ({
  status: 410,
  heading: "This link has expired",
  lead: `Connect links work once, for 10 minutes. ${BACK}`,
  hero: { kind: "status", tone: "warning", icon: "clock" },
});

export const expiredSignInLinkView = (): ConnectPageView => ({
  status: 410,
  heading: "This sign-in link has expired",
  lead: `Sign-in links work once, for 15 minutes at most. ${BACK}`,
  hero: { kind: "status", tone: "warning", icon: "clock" },
});

export const expiredSignInView = (): ConnectPageView => ({
  status: 410,
  heading: "This sign-in has expired",
  lead: `It was already used, or it took too long. ${BACK}`,
  hero: { kind: "status", tone: "warning", icon: "clock" },
});

export const signInCouldNotStartView = (): ConnectPageView => ({
  status: 502,
  heading: "Sign-in could not start",
  lead: "Nothing was connected. Go back to the app you came from and try again in a moment.",
  hero: { kind: "status", tone: "error", icon: "alert" },
});

export function connectedView(input: { integration: Integration | null; app: string | null | undefined }): ConnectPageView {
  const { integration, app } = input;
  const lead = app === null
    ? "You can close this window and go back to Anlyon."
    : app === undefined
      ? "You can close this window and go back to the app you came from."
      : `You can close this window and go back to ${app}'s app.`;
  return {
    status: 200,
    heading: integration ? `${integration.name} is connected` : "Account connected",
    lead,
    hero: integration && app !== undefined ? { kind: "pair", integration, app, connected: true } : { kind: "status", tone: "success", icon: "check" },
  };
}

export const accessNotApprovedView = (): ConnectPageView => ({
  status: 200,
  heading: "Access was not approved",
  lead: "Nothing was connected. You can close this window.",
  hero: { kind: "status", tone: "neutral", icon: "x" },
});

export const nothingConnectedView = (status: 200 | 502): ConnectPageView => ({
  status,
  heading: "Nothing was connected",
  lead: "You can close this window and go back to the app you came from.",
  hero: { kind: "status", tone: "neutral", icon: "x" },
});

export const notConnectedView = (status: 400 | 502, lead: string): ConnectPageView => ({
  status,
  heading: "The account was not connected",
  lead,
  hero: { kind: "status", tone: "error", icon: "alert" },
});

export const unavailableView = (): ConnectPageView => ({
  status: 501,
  heading: "Signing in is not available",
  lead: "Connected accounts that sign in are not set up on this deployment.",
  hero: { kind: "status", tone: "neutral", icon: "unplug" },
});

export const notFoundView = (): ConnectPageView => ({
  status: 404,
  heading: "There is nothing here",
  lead: "Connect links are opened from the app that sent them. If yours did not work, go back to that app and start again.",
  hero: { kind: "status", tone: "neutral", icon: "search" },
});
