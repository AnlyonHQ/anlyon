import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { API_BASE_URL } from "@/lib/constants";

interface StreamEvent {
	id: string;
	v: number;
	type: string;
	environmentId: string | null;
	data: Record<string, unknown>;
	ts: number;
}

export type RealtimeStatus =
	| "disabled"
	| "connecting"
	| "connected"
	| "reconnecting"
	| "disconnected";

function keysForEvent(type: string): string[] {
	if (type.startsWith("run.") || type.startsWith("spans.")) return ["runs"];
	if (type.startsWith("feedback.")) return ["runs"];
	if (type.startsWith("approval.")) return ["approvals"];
	if (type.startsWith("budget.")) return ["budgets", "usage"];
	if (type.startsWith("environment.")) return ["environments"];
	if (type.startsWith("action.")) return ["actions"];
	return [];
}

function invalidateForEvent(
	queryClient: ReturnType<typeof useQueryClient>,
	event: StreamEvent,
): void {
	for (const key of keysForEvent(event.type)) {
		queryClient.invalidateQueries({ queryKey: [key] });
	}
}

export function useRealtime(workspaceId?: string): RealtimeStatus {
	const queryClient = useQueryClient();
	const [status, setStatus] = useState<RealtimeStatus>(
		workspaceId ? "connecting" : "disabled",
	);

	useEffect(() => {
		if (!workspaceId) {
			setStatus("disabled");
			return;
		}
		const controller = new AbortController();
		let cursor: string | null = null;
		let stopped = false;
		setStatus("connecting");

		async function consume() {
			let backoff = 1000;
			while (!stopped) {
				try {
					const res = await fetch(`${API_BASE_URL}/api/v2/stream`, {
						method: "GET",
						credentials: "include",
						headers: {
							Accept: "text/event-stream",
							"X-Workspace-Id": workspaceId as string,
							...(cursor ? { "Last-Event-ID": cursor } : {}),
						},
						signal: controller.signal,
					});
					if (!res.ok || !res.body) {
						if (res.status === 401 || res.status === 403) {
							setStatus("disconnected");
							return;
						}
						setStatus("reconnecting");
						await sleep(backoff);
						backoff = Math.min(backoff * 2, 15000);
						continue;
					}
					backoff = 1000;
					setStatus("connected");
					const reader = res.body.getReader();
					const decoder = new TextDecoder();
					let buffer = "";
					for (;;) {
						const { value, done } = await reader.read();
						if (done) break;
						buffer += decoder.decode(value, { stream: true });
						while (true) {
							const boundary = buffer.indexOf("\n\n");
							if (boundary === -1) break;
							const block = buffer.slice(0, boundary);
							buffer = buffer.slice(boundary + 2);
							handleBlock(block);
						}
					}
				} catch {
					if (stopped) return;
					setStatus("reconnecting");
				}
				if (!stopped) {
					setStatus("reconnecting");
					await sleep(backoff);
					backoff = Math.min(backoff * 2, 15000);
				}
			}
		}

		function handleBlock(block: string) {
			let id: string | undefined;
			let event: string | undefined;
			const dataLines: string[] = [];
			for (const line of block.split("\n")) {
				if (line.startsWith(":")) continue;
				const colon = line.indexOf(":");
				const field = colon === -1 ? line : line.slice(0, colon);
				const val = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
				if (field === "id") id = val;
				else if (field === "event") event = val;
				else if (field === "data") dataLines.push(val);
			}
			if (id) cursor = id;
			if (!event || event === "heartbeat" || event === "ready") return;
			try {
				const parsed = JSON.parse(dataLines.join("\n")) as StreamEvent;
				invalidateForEvent(queryClient, parsed);
			} catch {
			}
		}

		consume();
		return () => {
			stopped = true;
			controller.abort();
		};
	}, [workspaceId, queryClient]);

	return status;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
