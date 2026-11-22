import { useCallback, useMemo } from "react";
import { useAuth } from "@/hooks/use-auth";
import {
	type ActorDirectory,
	type ActorRef,
	describeActor,
} from "@/lib/actor-label";
import { useApiKeys, useWorkspaceMembers } from "./use-workspaces";

export function useActorNames(workspaceId?: string) {
	const members = useWorkspaceMembers(workspaceId ?? "");
	const keys = useApiKeys(workspaceId ?? "");
	const { user } = useAuth();

	const directory = useMemo<ActorDirectory>(
		() => ({
			users: members.data
				? new Map(
						members.data.map((member) => [
							member.userId,
							{ name: member.user?.name, email: member.user?.email },
						]),
					)
				: undefined,
			keys: keys.data
				? new Map(keys.data.map((key) => [key.id, key.name]))
				: undefined,
			currentUserId: user?.id ?? null,
		}),
		[members.data, keys.data, user?.id],
	);

	return useCallback(
		(actor: ActorRef) => describeActor(actor, directory),
		[directory],
	);
}
