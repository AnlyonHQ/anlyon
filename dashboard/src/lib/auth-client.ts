import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { oneTapClient, twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { API_BASE_URL } from "./constants";

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || "";

export const authClient = createAuthClient({
	baseURL: API_BASE_URL,
	plugins: [
		oneTapClient({
			clientId: GOOGLE_CLIENT_ID,
			autoSelect: false,
			cancelOnTapOutside: true,
			context: "signin",
			promptOptions: {
				baseDelay: 1000,
				maxAttempts: 5,
			},
		}),
		twoFactorClient({ twoFactorPage: "/auth/two-factor" }),
		oauthProviderClient(),
	],
});
