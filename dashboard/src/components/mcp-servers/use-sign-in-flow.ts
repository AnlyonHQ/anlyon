import { useEffect, useState } from "react";
import { toast } from "@/components/ui/toast";
import {
	useConnectMcpUpstream,
	useMcpUpstreams,
} from "@/hooks/api/use-mcp-upstreams";
import {
	type SignInProgress,
	type SignInStart,
	signInProgress,
} from "@/lib/mcp-servers";

const POLL_MS = 3000;

export interface SignInFlow {
	begin: () => void;
	pending: boolean;
	progress: SignInProgress | null;
	url: string | null;
}

export function useSignInFlow(workspaceId: string | undefined, name: string) {
	const [start, setStart] = useState<SignInStart | null>(null);
	const [polling, setPolling] = useState(false);
	const query = useMcpUpstreams(workspaceId, polling ? POLL_MS : undefined);
	const connect = useConnectMcpUpstream(workspaceId);
	const server = query.data?.find((item) => item.name === name);
	const progress =
		start && server
			? signInProgress(start, server, query.dataUpdatedAt || Date.now())
			: null;
	const listedCount = server?.tools.length ?? 0;

	useEffect(() => {
		if (progress === "listed") {
			toast.success(
				`Signed in. ${listedCount} ${listedCount === 1 ? "tool" : "tools"} listed.`,
			);
		}
		if (progress === "listed" || progress === "failed") {
			setStart(null);
			setPolling(false);
		}
		if (progress === "expired") setPolling(false);
	}, [progress, listedCount]);

	const begin = () => {
		if (!server) return;
		const tab = window.open("about:blank", "_blank");
		connect.mutate(server.id, {
			onSuccess: (started) => {
				if (tab) {
					tab.opener = null;
					tab.location.href = started.url;
				}
				setStart({
					url: started.url,
					expiresAt: started.expiresAt,
					updatedAt: server.updatedAt,
					listedAt: server.listedAt,
					errorAt: server.lastError?.at ?? null,
				});
				setPolling(true);
			},
			onError: () => tab?.close(),
		});
	};

	const signIn: SignInFlow = {
		begin,
		pending: connect.isPending,
		progress,
		url: start?.url ?? null,
	};
	return { query, server, signIn };
}
