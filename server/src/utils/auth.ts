import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt, oneTap, twoFactor } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { sso } from "@better-auth/sso";
import { db } from "../db/index.ts";
import { env } from "../config/env.ts";
import dotenv from "dotenv";
import { user } from "../db/schema/user.ts";
import { verification } from "../db/schema/verification.ts";
import { session } from "../db/schema/session.ts";
import { account } from "../db/schema/account.ts";
import { rateLimit } from "../db/schema/rate-limit.ts";
import { twoFactor as twoFactorTable } from "../db/schema/two-factor.ts";
import {
  jwks,
  oauthAccessToken,
  oauthClient,
  oauthClientAssertion,
  oauthClientResource,
  oauthConsent,
  oauthRefreshToken,
  oauthResource,
} from "../db/schema/oauth.ts";
import { ALL_OAUTH_SCOPES, DEFAULT_OAUTH_SCOPES } from "../core/auth/oauth-scopes.ts";
import { registrationAfterHook, registrationBeforeHook } from "../core/auth/oauth-registration.ts";
import { idTokenProfileClaims } from "../core/auth/oauth-id-token.ts";
import {
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendPasswordChangedEmail,
  sendWelcomeEmail,
} from "../lib/emails/send-auth-email.ts";
import { logger } from "../lib/logger.ts";
import { captureUserSignedUp } from "../lib/product-events.ts";
import { getFirstPartyClient, scopesNeedWorkspace, signUpProperties } from "../core/auth/first-party-clients.ts";
import { authorizeQueryFromVerificationUrl, returnPathFromVerificationUrl } from "../core/auth/oauth-return.ts";
import { getAllowedOrigins } from "./origins.ts";
import { isCloudEdition } from "../core/edition/edition.ts";
import { defaultSignupChecks, requiresEmailVerification, signupRefusal, ssoSignupChecks } from "../core/edition/signup.ts";
import { isEmailConfigured } from "../lib/resend-client.ts";
import { httpsRequired } from "../api/middleware/security.ts";
import { MCP_RESOURCE_URL } from "../api/mcp-challenge.ts";
import { ssoProvider } from "../db/schema/sso.ts";
import { afterSessionCreate, beforeSessionCreate, isSsoCallback } from "../core/sso/sessions.ts";
import { provisionSsoUser, ssoLinkRefusal, ssoSignupRefusal } from "../core/sso/provisioning.ts";
import { withSsoSecretEncryption } from "../core/sso/secret-fields.ts";

const SSO_MANAGEMENT_PATHS = [
    "/sso/register",
    "/sso/providers",
    "/sso/get-provider",
    "/sso/update-provider",
    "/sso/delete-provider",
    "/sso/request-domain-verification",
    "/sso/verify-domain",
];

dotenv.config();

const getTrustedOrigins = (): string[] => {
  return getAllowedOrigins();
};

const getFrontendURL = (): string => {
  if (!isCloudEdition()) return env.FRONTEND_URL ?? env.CONSOLE_URL;
  if (env.NODE_ENV === "production") {
    return "https://console.anlyon.com";
  }
  return "http://localhost:3000";
};

export { MCP_RESOURCE_URL };

export const AUTH_BASE_PATH = "/api/auth";

export const OAUTH_ISSUER = `${env.BETTER_AUTH_URL}${AUTH_BASE_PATH}`;

export const auth = betterAuth({
    appName: "Anlyon",
    database: withSsoSecretEncryption(drizzleAdapter(db, {
        provider: "pg",
        schema:{
            user: user,
            session: session,
            verification: verification,
            account: account,
            rateLimit: rateLimit,
            twoFactor: twoFactorTable,
            oauthClient: oauthClient,
            oauthAccessToken: oauthAccessToken,
            oauthRefreshToken: oauthRefreshToken,
            oauthConsent: oauthConsent,
            oauthResource: oauthResource,
            oauthClientResource: oauthClientResource,
            oauthClientAssertion: oauthClientAssertion,
            jwks: jwks,
            ssoProvider: ssoProvider,
        }
    })),
    disabledPaths: SSO_MANAGEMENT_PATHS,
    hooks: {
        before: registrationBeforeHook,
        after: registrationAfterHook,
    },
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: getTrustedOrigins(),
    rateLimit: {
        enabled: env.NODE_ENV !== "development",
        storage: "database",
        window: 60,
        max: 100,
        customRules: {
            "/sign-in/email": { window: 60, max: 5 },
            "/sign-up/email": { window: 60, max: 3 },
            "/request-password-reset": { window: 60, max: 3 },
            "/oauth2/token": { window: 60, max: 120 },
            "/oauth2/register": { window: 60, max: 10 },
        },
    },
    databaseHooks: {
        session: {
            create: {
                before: async (newSession, hookCtx) => {
                    await beforeSessionCreate(newSession, hookCtx as never);
                },
                after: async (createdSession, hookCtx) => {
                    try {
                        await afterSessionCreate(createdSession, hookCtx as never);
                    } catch (error) {
                        logger.error({ error }, "Failed to record the SSO provider of a session");
                    }
                },
            },
        },
        account: {
            create: {
                before: async (newAccount, hookCtx) => {
                    if (!hookCtx) return;
                    const refusal = await ssoLinkRefusal(
                        { userId: newAccount.userId, providerId: newAccount.providerId },
                        hookCtx as never,
                    );
                    if (refusal) throw new APIError("FORBIDDEN", { message: refusal, code: "SSO_DOMAIN_NOT_VERIFIED" });
                },
            },
        },
        user: {
            create: {
                before: async (newUser, hookCtx) => {
                    if (!hookCtx) return;
                    const viaSso = isSsoCallback((hookCtx as { path?: string }).path);
                    const ssoRefusal = await ssoSignupRefusal(newUser.email, hookCtx as never);
                    if (ssoRefusal) throw new APIError("FORBIDDEN", { message: ssoRefusal, code: "SSO_DOMAIN_NOT_VERIFIED" });
                    const checks = defaultSignupChecks();
                    const refusal = await signupRefusal(newUser.email, viaSso ? ssoSignupChecks(checks) : checks);
                    if (refusal) throw new APIError("FORBIDDEN", { message: refusal, code: "SIGNUP_RESTRICTED" });
                    if (viaSso) {
                        return { data: { ...newUser, emailVerified: true } };
                    }
                    if (!isCloudEdition() && !isEmailConfigured()) {
                        return { data: { ...newUser, emailVerified: true } };
                    }
                },
                after: async (createdUser, hookCtx) => {
                    try {
                        const path =
                            (hookCtx as { path?: string } | undefined)?.path ?? "";
                        const { currentOAuthClientId } = await import("../core/auth/oauth-tokens.ts");
                        const clientId = await currentOAuthClientId();
                        const firstParty = clientId ? await getFirstPartyClient(clientId) : null;
                        captureUserSignedUp(createdUser.id, signUpProperties(path, firstParty?.key));
                    } catch (error) {
                        logger.error({ error }, "Failed to capture user_signed_up");
                    }
                },
            },
        },
    },
    advanced: {
        disableCSRFCheck: false,
        useSecureCookies: httpsRequired(),
        ipAddress: {
            ipAddressHeaders: ["x-forwarded-for", "x-real-ip"],
        },
    },
    plugins: [
        oneTap({
            clientId: env.GOOGLE_CLIENT_ID,
        }),
        twoFactor({
            issuer: "Anlyon",
            allowPasswordless: true,
        }),
        sso({
            domainVerification: { enabled: true },
            provisionUser: provisionSsoUser,
            provisionUserOnEveryLogin: true,
            organizationProvisioning: { disabled: true },
            providersLimit: 1000,
            saml: {
                requireTimestamps: true,
                algorithms: { onDeprecated: "reject" },
                allowIdpInitiated: false,
            },
        }),
        jwt(),
        oauthProvider({
            loginPage: `${getFrontendURL()}/auth/login`,
            consentPage: `${getFrontendURL()}/oauth/consent`,
            postLogin: {
                page: `${getFrontendURL()}/oauth/workspace`,
                shouldRedirect: async ({ user, scopes }) => {
                    if (!scopesNeedWorkspace(scopes)) return false;

                    const { ensureFirstWorkspace, getUserWorkspaces } = await import("../core/workspace/service.ts");
                    const { currentOAuthClientId, hasWorkspaceBinding } = await import("../core/auth/oauth-tokens.ts");

                    if (await ensureFirstWorkspace(user.id, user.name ? `${user.name}'s workspace` : "My workspace")) return false;

                    if ((await getUserWorkspaces(user.id)).length <= 1) return false;

                    const clientId = await currentOAuthClientId();
                    if (!clientId) {
                        logger.warn("OAuth client_id unreadable during postLogin; showing the workspace picker");
                        return true;
                    }
                    return !(await hasWorkspaceBinding(user.id, clientId));
                },
                consentReferenceId: async ({ user, session }) => {
                    const { assertSsoForOAuthGrant, getPendingBindingReference } = await import("../core/auth/oauth-tokens.ts");
                    const { SsoRequiredError } = await import("../core/sso/sessions.ts");
                    try {
                        await assertSsoForOAuthGrant(user.id, session?.id);
                    } catch (error) {
                        if (error instanceof SsoRequiredError) {
                            throw new APIError("FORBIDDEN", { message: error.message, code: "SSO_REQUIRED" });
                        }
                        throw error;
                    }
                    return getPendingBindingReference(user.id);
                },
            },
            allowDynamicClientRegistration: true,
            allowUnauthenticatedClientRegistration: true,
            clientPrivileges: ({ action }) => action === "read" || action === "list",
            clientRegistrationDefaultApplicationType: "infer",
            resources: [{ identifier: MCP_RESOURCE_URL, name: "Anlyon MCP server" }],
            resourceSeedMode: "overwrite",
            enforcePerClientResources: false,
            resourcePrivileges: () => false,
            scopes: ALL_OAUTH_SCOPES,
            clientRegistrationDefaultScopes: DEFAULT_OAUTH_SCOPES,
            clientRegistrationAllowedScopes: ALL_OAUTH_SCOPES,
            accessTokenExpiresIn: 900,
            refreshTokenExpiresIn: 7 * 24 * 60 * 60,
            customIdTokenClaims: ({ user, scopes }) => idTokenProfileClaims(user, scopes),
        }),
    ],
    emailAndPassword: {
        enabled: true,
        requireEmailVerification: requiresEmailVerification(),
        revokeSessionsOnPasswordReset:true,
        sendResetPassword: async ({ user, url, token }, request) => {
            try {
                await sendPasswordResetEmail({
                    email: user.email,
                    userName: user.name,
                    resetUrl: url,
                });
            } catch (error) {
                logger.error({ error, email: user.email }, "Failed to send password reset email");
                throw error;
            }
        },
        onPasswordReset: async ({ user }, request:any) => {
            try {
                const ipAddress = request.headers.get("x-forwarded-for") ||
                                request.headers.get("x-real-ip") ||
                                "unknown";
                await sendPasswordChangedEmail({
                    email: user.email,
                    userName: user.name,
                    ipAddress: ipAddress,
                });
            } catch (error) {
                logger.error({ error, email: user.email }, "Failed to send password changed email");
            }
        },
        maxPasswordLength: 100,
        minPasswordLength: 8,
    },
    emailVerification: {
        sendVerificationEmail: async ({ user, url, token }, request) => {
            try {
                const frontendUrl = (env.FRONTEND_URL || getFrontendURL()).replace(/\/$/, "");
                const verificationUrl = new URL(`${frontendUrl}/auth/verify-email`);
                verificationUrl.searchParams.set("token", token);
                const oauthQuery = authorizeQueryFromVerificationUrl(url);
                if (oauthQuery) verificationUrl.searchParams.set("oauth_query", oauthQuery);
                const returnTo = returnPathFromVerificationUrl(url);
                if (returnTo) verificationUrl.searchParams.set("return_to", returnTo);

                await sendVerificationEmail({
                    email: user.email,
                    userName: user.name,
                    verificationUrl: verificationUrl.toString(),
                });
            } catch (error) {
                logger.error({ error, email: user.email }, "Failed to send verification email");
                throw error;
            }
        },
        afterEmailVerification: async (user, request) => {
            try {
                await sendWelcomeEmail({
                    email: user.email,
                    userName: user.name,
                });
            } catch (error) {
                logger.error({ error, email: user.email }, "Failed to send welcome email");
            }
        },
    },
    socialProviders: {
        ...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
            ? { github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } }
            : {}),
        ...(isCloudEdition() || (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
            ? { google: { clientId: env.GOOGLE_CLIENT_ID as string, clientSecret: env.GOOGLE_CLIENT_SECRET as string } }
            : {}),
    },
    account: {
        encryptOAuthTokens: true,
    },
});
