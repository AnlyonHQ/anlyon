import { TeamPlanNotice } from "@/components/plan/team-plan-notice";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogPopup,
	DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import {
	Select,
	SelectItem,
	SelectPopup,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	ASSIGNABLE_ROLE_ORDER,
	ROLE_LABELS,
	useRemoveEnvironmentRole,
	useSetEnvironmentRole,
} from "@/hooks/api/use-permissions";
import { usePlanAccess } from "@/hooks/use-plan-access";
import type {
	Environment,
	EnvironmentRole,
	WorkspaceMember,
} from "@/lib/types";

const WORKSPACE_ROLE = "workspace";

export function EnvironmentRolesDialog({
	open,
	onOpenChange,
	workspaceId,
	member,
	environments,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	workspaceId: string;
	member: WorkspaceMember | null;
	environments: Environment[];
}) {
	const setRole = useSetEnvironmentRole();
	const removeRole = useRemoveEnvironmentRole();
	const busy = setRole.isPending || removeRole.isPending;
	const { teamPlanRequired } = usePlanAccess(workspaceId);

	if (!member) return null;
	const grants = new Map(
		(member.environmentRoles ?? []).map((grant) => [
			grant.environmentId,
			grant.role,
		]),
	);
	const name = member.user?.name || member.user?.email || member.userId;

	const change = (environmentId: string, value: string) => {
		if (value === (grants.get(environmentId) ?? WORKSPACE_ROLE)) return;
		if (value === WORKSPACE_ROLE) {
			removeRole.mutate({ workspaceId, userId: member.userId, environmentId });
		} else {
			setRole.mutate({
				workspaceId,
				userId: member.userId,
				environmentId,
				role: value as EnvironmentRole,
			});
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogPopup className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Environment roles</DialogTitle>
					<DialogDescription>
						{name} is {articleFor(member.role)}{" "}
						{ROLE_LABELS[member.role].toLowerCase()} in this workspace. Give a
						different role in one environment, for example approver in
						production only.
					</DialogDescription>
				</DialogHeader>
				<DialogPanel className="grid gap-4">
					<TeamPlanNotice
						feature="Roles per environment"
						hasConfiguration={grants.size > 0}
						variant="inline"
					/>
					{environments.map((environment) => (
						<Field key={environment.id}>
							<FieldLabel htmlFor={`env-role-${environment.id}`}>
								{environment.name}
							</FieldLabel>
							<Select
								value={grants.get(environment.id) ?? WORKSPACE_ROLE}
								onValueChange={(value) => {
									if (value) change(environment.id, value as string);
								}}
								disabled={busy}
							>
								<SelectTrigger id={`env-role-${environment.id}`}>
									<SelectValue />
								</SelectTrigger>
								<SelectPopup>
									<SelectItem value={WORKSPACE_ROLE}>
										Workspace role ({ROLE_LABELS[member.role]})
									</SelectItem>
									{ASSIGNABLE_ROLE_ORDER.map((role) => (
										<SelectItem
											disabled={
												teamPlanRequired && grants.get(environment.id) !== role
											}
											key={role}
											value={role}
										>
											{ROLE_LABELS[role]}
										</SelectItem>
									))}
								</SelectPopup>
							</Select>
						</Field>
					))}
				</DialogPanel>
				<DialogFooter>
					<DialogClose render={<Button variant="ghost" />}>Done</DialogClose>
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	);
}

function articleFor(role: string): string {
	return /^[aeiou]/.test(role) ? "an" : "a";
}
