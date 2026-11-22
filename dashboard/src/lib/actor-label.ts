export type ActorRef = { type: string; id: string | null } | null | undefined;

export interface ActorDirectory {
	users?: ReadonlyMap<string, { name?: string | null; email?: string | null }>;
	keys?: ReadonlyMap<string, string>;
	currentUserId?: string | null;
}

export interface ActorLabel {
	text: string;
	title?: string;
}

const shortId = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…` : id);

export function describeActor(
	actor: ActorRef,
	directory: ActorDirectory = {},
): ActorLabel {
	if (!actor?.id || actor.type === "unknown") return { text: "Not recorded" };
	const { id } = actor;

	if (actor.type === "user") {
		const isYou = !!directory.currentUserId && directory.currentUserId === id;
		const member = directory.users?.get(id);
		if (member) {
			const name = member.name?.trim() || member.email?.trim() || "A member";
			const title =
				member.email && member.name?.trim() ? `${member.email} · ${id}` : id;
			return { text: isYou ? `${name} (you)` : name, title };
		}
		if (isYou) return { text: "You", title: id };
		if (directory.users) return { text: "Former member", title: id };
		return { text: `User ${shortId(id)}`, title: id };
	}

	if (actor.type === "api_key") {
		const name = directory.keys?.get(id);
		if (name) return { text: `API key "${name}"`, title: id };
		if (directory.keys)
			return { text: "Revoked or deleted API key", title: id };
		return { text: `API key ${shortId(id)}`, title: id };
	}

	return { text: `${actor.type} ${shortId(id)}`, title: id };
}
