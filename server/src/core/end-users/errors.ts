import { ApiError } from "../../utils/errors.ts";
import { END_USER_HEADER } from "./identity.ts";

export class EndUserRequiredError extends ApiError {
  constructor() {
    super(400, "END_USER_REQUIRED", `This API key acts only for an end user. Send the ${END_USER_HEADER} header.`);
    this.name = "EndUserRequiredError";
  }
}

export interface ConnectLinkView {
  url: string;
  expiresAt: Date;
}

export type EndUserConnectionCode = "END_USER_NOT_CONNECTED" | "END_USER_RECONNECT_REQUIRED";

export class EndUserConnectionError extends ApiError {
  constructor(
    code: EndUserConnectionCode,
    readonly integration: string,
    readonly endUserId: string,
    readonly link: ConnectLinkView | null,
    message: string,
    readonly displayName: string = integration,
  ) {
    super(409, code, message);
    this.name = "EndUserConnectionError";
    this.fix = {
      summary: link
        ? "Send the end user to connectUrl to connect the account, then retry."
        : "Create a connect link for this end user, send them to it, then retry.",
      docs: "https://docs.anlyon.com/execution/end-user-connections",
    };
  }

  override toJSON() {
    return {
      success: false,
      error: {
        code: this.code,
        message: this.message,
        integration: this.integration,
        displayName: this.displayName,
        endUserId: this.endUserId,
        details: this.details,
        ...(this.link ? { connectUrl: this.link.url, expiresAt: this.link.expiresAt.toISOString() } : {}),
        ...(this.fix ? { fix: this.fix } : {}),
      },
    };
  }
}

export class EndUserMismatchError extends ApiError {
  constructor(message = "This connection was not started for this end user. Nothing was stored.") {
    super(403, "END_USER_MISMATCH", message);
    this.name = "EndUserMismatchError";
  }
}

export class RedirectUrlRequiredError extends ApiError {
  constructor() {
    super(
      400,
      "REDIRECT_URL_REQUIRED",
      "A connect link needs a redirectUrl from this environment's allowed redirect URLs, or a default redirect URL. Set them under Integrations, Connect settings.",
    );
    this.name = "RedirectUrlRequiredError";
  }
}

export class OwnOAuthAppRequiredError extends ApiError {
  constructor(integration: string, displayName: string) {
    super(
      400,
      "OWN_OAUTH_APP_REQUIRED",
      `${displayName} is connected through this environment's own OAuth app. Add yours on the integration's page under Integrations (PUT /api/v2/environments/{environmentId}/oauth-apps/${integration}), then create the link again.`,
      { integration },
    );
    this.name = "OwnOAuthAppRequiredError";
  }
}
