import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { PageSection } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RelativeTime } from "@/components/ui/relative-time";
import {
	type McpUpstream,
	useMcpUpstreamConnectLink,
} from "@/hooks/api/use-mcp-upstreams";
import { CopyValue } from "./copy-value";
import type { SignInFlow } from "./use-sign-in-flow";

export function PeopleTab({
	server,
	workspaceId,
	canManage,
	signIn,
}: {
	server: McpUpstream;
	workspaceId?: string;
	canManage: boolean;
	signIn: SignInFlow;
}) {
	const id = useId();
	const link = useMcpUpstreamConnectLink(workspaceId);
	const [endUserId, setEndUserId] = useState("");
	const [created, setCreated] = useState<{
		url: string;
		expiresAt: string;
		endUserId: string;
	} | null>(null);
	const connected = !!server.oauth?.operatorConnected;

	return (
		<div className="flex flex-col gap-6">
			<PageSection
				actions={
					canManage ? (
						<Button
							loading={signIn.pending}
							onClick={signIn.begin}
							size="sm"
							variant="outline"
						>
							{connected ? "Reconnect" : "Connect your account"}
						</Button>
					) : null
				}
				description={
					connected
						? "Anlyon lists this server's tools with it, and a call made for no end user acts as you."
						: "A call made for no end user is refused until you connect it. Calls made for your users do not need it."
				}
				title={
					<span className="inline-flex items-center gap-2">
						Your account
						<Badge variant={connected ? "success" : "outline"}>
							{connected ? "Connected" : "Not connected"}
						</Badge>
					</span>
				}
			/>
			<PageSection
				description="Each person signs in with their own account, and a call made for them carries their own token. The server sees them, not you, and they can only do what their account can."
				title="Your users"
			>
				{canManage ? (
					<form
						className="flex flex-wrap items-end gap-2"
						onSubmit={(event) => {
							event.preventDefault();
							const person = endUserId.trim();
							if (!person) return;
							link.mutate(
								{ id: server.id, endUserId: person },
								{
									onSuccess: (made) =>
										setCreated({ ...made, endUserId: person }),
								},
							);
						}}
					>
						<div className="min-w-0 flex-1 basis-56 space-y-1.5 sm:max-w-xs">
							<Label htmlFor={`${id}-user`}>End user id</Label>
							<Input
								autoComplete="off"
								className="font-mono"
								id={`${id}-user`}
								maxLength={256}
								onChange={(event) => setEndUserId(event.target.value)}
								placeholder="user_123"
								spellCheck={false}
								value={endUserId}
							/>
						</div>
						<Button
							disabled={!endUserId.trim()}
							loading={link.isPending}
							type="submit"
							variant="outline"
						>
							Create connect link
						</Button>
					</form>
				) : null}
				{created ? (
					<div className="flex flex-col gap-1.5">
						<CopyValue label="connect link" value={created.url} />
						<p className="text-muted-foreground text-xs">
							For <span className="font-mono">{created.endUserId}</span> only:
							whoever opens it connects an account as them, so send it to no one
							else. It expires <RelativeTime value={created.expiresAt} />.
						</p>
					</div>
				) : null}
				<p className="text-[13px] text-muted-foreground">
					See who your users are on the{" "}
					<Link className="underline underline-offset-2" to="/users">
						Users page
					</Link>
					.
				</p>
			</PageSection>
		</div>
	);
}
