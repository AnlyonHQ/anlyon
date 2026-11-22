import type { AuthorizeRequest, FirstPartyClient } from "@/lib/oauth-return";

export function AuthorizeRequestNotice({
	request,
	firstParty,
}: {
	request: AuthorizeRequest | null;
	firstParty: FirstPartyClient | null;
}) {
	if (!request) return null;
	if (request.expired) {
		return (
			<p className="text-sm text-muted-foreground" role="status">
				This sign-in request expired.{" "}
				{firstParty ? (
					<a
						href={firstParty.startUrl}
						className="font-medium text-primary hover:underline"
					>
						Start again from {firstParty.displayName}
					</a>
				) : (
					"Start again from the app you came from."
				)}
			</p>
		);
	}
	if (!firstParty) return null;
	return (
		<p className="text-sm text-muted-foreground">
			Continue to {firstParty.displayName}
		</p>
	);
}
