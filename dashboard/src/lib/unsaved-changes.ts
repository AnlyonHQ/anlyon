import { useBlocker } from "@tanstack/react-router";
import { useEffect, useId } from "react";

const owners = new Set<string>();

export function hasUnsavedChanges(): boolean {
	return owners.size > 0;
}

export function useUnsavedChangesGuard(dirty: boolean) {
	const owner = useId();
	useEffect(() => {
		if (dirty) owners.add(owner);
		else owners.delete(owner);
		return () => {
			owners.delete(owner);
		};
	}, [dirty, owner]);

	return useBlocker({
		shouldBlockFn: () => true,
		disabled: !dirty,
		enableBeforeUnload: dirty,
		withResolver: true,
	});
}
