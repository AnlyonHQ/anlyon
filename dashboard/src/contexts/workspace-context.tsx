import { useQueryClient } from "@tanstack/react-query";
import type React from "react";
import { createContext, useContext, useEffect, useState } from "react";
import { useWorkspaces } from "@/hooks/api/use-workspaces";
import { secureStorage } from "@/lib/storage";
import type { Workspace } from "@/lib/types";
import { hasUnsavedChanges } from "@/lib/unsaved-changes";

interface WorkspaceContextType {
	currentWorkspace: Workspace | null;
	workspaces: Workspace[];
	isLoading: boolean;
	switchWorkspace: (workspaceId: string) => void;
	hasWorkspaces: boolean;
}

const WorkspaceContext = createContext<WorkspaceContextType | undefined>(
	undefined,
);

const WORKSPACE_STORAGE_KEY = "current_workspace_id";

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
	const { data: workspaces = [], isLoading } = useWorkspaces();
	const queryClient = useQueryClient();
	const [currentWorkspace, setCurrentWorkspace] = useState<Workspace | null>(
		null,
	);

	useEffect(() => {
		if (!isLoading && workspaces.length > 0) {
			const validWorkspaces = workspaces.filter((w) => w?.id && w.name);

			if (validWorkspaces.length === 0) return;

			const savedWorkspaceId = secureStorage.getItem(WORKSPACE_STORAGE_KEY);

			if (savedWorkspaceId) {
				const workspace = validWorkspaces.find(
					(w) => w.id === savedWorkspaceId,
				);
				if (workspace) {
					setCurrentWorkspace(workspace);
					return;
				}
			}

			setCurrentWorkspace(validWorkspaces[0]);
			secureStorage.setItem(WORKSPACE_STORAGE_KEY, validWorkspaces[0].id);
		}
	}, [workspaces, isLoading]);

	const switchWorkspace = (workspaceId: string) => {
		const validWorkspaces = workspaces.filter((w) => w?.id && w.name);
		const workspace = validWorkspaces.find((w) => w.id === workspaceId);
		if (!workspace || workspace.id === currentWorkspace?.id) return;
		if (
			hasUnsavedChanges() &&
			!window.confirm(
				"You have unsaved changes on this page. Switch workspace and discard them?",
			)
		) {
			return;
		}

		queryClient.cancelQueries();
		queryClient.clear();
		setCurrentWorkspace(workspace);
		secureStorage.setItem(WORKSPACE_STORAGE_KEY, workspaceId);
	};

	const validWorkspaces = workspaces.filter((w) => w?.id && w.name);

	return (
		<WorkspaceContext.Provider
			value={{
				currentWorkspace,
				workspaces: validWorkspaces,
				isLoading,
				switchWorkspace,
				hasWorkspaces: validWorkspaces.length > 0,
			}}
		>
			{children}
		</WorkspaceContext.Provider>
	);
}

export function useWorkspace() {
	const context = useContext(WorkspaceContext);
	if (context === undefined) {
		throw new Error("useWorkspace must be used within a WorkspaceProvider");
	}
	return context;
}
