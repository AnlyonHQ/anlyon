import { Link } from "@tanstack/react-router";
import { ArrowRight, CircleAlert, CircleCheck, CircleDot } from "lucide-react";
import type * as React from "react";
import { LiveDot } from "@/components/first-run/steps";
import { Button } from "@/components/ui/button";
import type { McpUpstream } from "@/hooks/api/use-mcp-upstreams";
import { hostOf, nextStep } from "@/lib/mcp-servers";
import { cn } from "@/lib/utils";
import { TOOLS_LIST_ID } from "./tools-tab";
import type { SignInFlow } from "./use-sign-in-flow";

type Tone = "next" | "warning" | "error" | "live" | "waiting";

const ICON: Record<Tone, React.ReactNode> = {
	next: <CircleDot aria-hidden="true" className="size-4 text-foreground" />,
	warning: (
		<CircleAlert
			aria-hidden="true"
			className="size-4 text-warning-foreground"
		/>
	),
	error: <CircleAlert aria-hidden="true" className="size-4 text-destructive" />,
	live: (
		<CircleCheck
			aria-hidden="true"
			className="size-4 text-success-foreground"
		/>
	),
	waiting: <LiveDot className="mx-[5px]" />,
};

function Strip({
	tone,
	title,
	line,
	action,
}: {
	tone: Tone;
	title: string;
	line: React.ReactNode;
	action?: React.ReactNode;
}) {
	return (
		<section
			aria-label="Next step"
			aria-live="polite"
			className={cn(
				"flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-card px-3.5 py-3",
				tone === "warning" && "border-warning/40",
				tone === "error" && "border-destructive/40",
			)}
			data-slot="next-step"
			data-tone={tone}
		>
			<span className="flex size-4 shrink-0 items-center self-start pt-0.5">
				{ICON[tone]}
			</span>
			<div className="min-w-0 flex-1 basis-64">
				<p className="font-medium text-[13.5px] leading-5">{title}</p>
				<p className="text-pretty text-[13px] text-muted-foreground leading-relaxed">
					{line}
				</p>
			</div>
			{action ? <div className="shrink-0 ps-7 sm:ps-0">{action}</div> : null}
		</section>
	);
}

export function NextStepStrip({
	server,
	canManage,
	signIn,
	refresh,
	refreshing,
}: {
	server: McpUpstream;
	canManage: boolean;
	signIn: SignInFlow;
	refresh: () => void;
	refreshing: boolean;
}) {
	const toolsLink = (search: Record<string, string>, label: string) => (
		<Button
			onClick={() =>
				document
					.getElementById(TOOLS_LIST_ID)
					?.scrollIntoView({ behavior: "smooth", block: "start" })
			}
			render={
				<Link
					params={{ name: server.name }}
					search={search}
					to="/mcp-servers/$name"
				/>
			}
			size="sm"
		>
			{label}
			<ArrowRight aria-hidden="true" />
		</Button>
	);

	if (signIn.progress === "waiting" || signIn.progress === "listing") {
		const waiting = signIn.progress === "waiting";
		return (
			<Strip
				action={
					waiting && signIn.url ? (
						<Button
							render={
								// biome-ignore lint/a11y/useAnchorContent: the button's children fill it
								<a
									href={signIn.url}
									rel="noopener noreferrer"
									target="_blank"
								/>
							}
							size="sm"
							variant="outline"
						>
							Open sign-in again
						</Button>
					) : null
				}
				line={
					waiting
						? "Finish in the tab that opened. This page updates by itself. If no tab opened, a popup blocker may have stopped it."
						: "Your account is connected. Anlyon is asking the server for its tools."
				}
				title={
					waiting
						? "Waiting for you to sign in"
						: "Signed in. Listing its tools"
				}
				tone="waiting"
			/>
		);
	}

	const retryConnect = canManage ? (
		<Button loading={signIn.pending} onClick={signIn.begin} size="sm">
			{server.oauth?.operatorConnected
				? "Reconnect your account"
				: "Connect your account"}
		</Button>
	) : null;

	if (signIn.progress === "expired") {
		return (
			<Strip
				action={retryConnect}
				line="The sign-in link only lasts a few minutes. Nothing was connected. Start again when you are ready."
				title="That sign-in link expired"
				tone="warning"
			/>
		);
	}

	const listAgain = canManage ? (
		<Button loading={refreshing} onClick={refresh} size="sm">
			List again
		</Button>
	) : null;

	const step = nextStep(server);
	switch (step.kind) {
		case "sign-in":
			return (
				<Strip
					action={retryConnect}
					line={`${hostOf(server.url)} only shows its tools to someone signed in. Connect your own account to list them. Calls made for no end user will use it too.`}
					title="Sign in to see this server's tools"
					tone="next"
				/>
			);
		case "listing-failed":
			return (
				<Strip
					action={listAgain}
					line={
						server.oauth
							? `${step.message} If your sign-in has expired, reconnect from the People tab.`
							: step.message
					}
					title="The last listing failed"
					tone="error"
				/>
			);
		case "review": {
			const count = step.changed + step.missing;
			return (
				<Strip
					action={toolsLink(
						{ filter: "review" },
						count === 1 ? "Review it" : "Review them",
					)}
					line={`Anlyon refuses calls to ${count === 1 ? "it" : "them"} until you do.`}
					title={`${count} adopted ${count === 1 ? "tool" : "tools"} changed on the server`}
					tone="warning"
				/>
			);
		}
		case "no-tools":
			return (
				<Strip
					action={listAgain}
					line="There is nothing to adopt yet. List it again once the server has tools."
					title="This server lists no tools"
					tone="next"
				/>
			);
		case "choose-tools":
			return (
				<Strip
					action={toolsLink({}, "Choose tools")}
					line={`Nothing is reachable yet. The server lists ${step.toolCount} ${step.toolCount === 1 ? "tool" : "tools"}, and your agent can call none until you adopt them.`}
					title="Choose the tools your agent may call"
					tone="next"
				/>
			);
		case "live":
			return (
				<Strip
					action={toolsLink({ tab: "use" }, "How to call them")}
					line="Your agent can call them under your approvals and receipts. A tool that changes is refused until you review it."
					title={`${step.live} ${step.live === 1 ? "tool" : "tools"} live`}
					tone="live"
				/>
			);
	}
}
