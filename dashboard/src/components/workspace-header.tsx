import { Building2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useWorkspace } from "@/contexts/workspace-context";

export function WorkspaceHeader() {
	const { currentWorkspace } = useWorkspace();

	if (!currentWorkspace) return null;

	return (
		<div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
			<Building2 className="h-4 w-4" />
			<span>{currentWorkspace.name}</span>
			<Badge variant="outline" className="text-xs">
				{currentWorkspace.plan}
			</Badge>
		</div>
	);
}
