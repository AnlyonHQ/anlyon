import { useId } from "react";
import { Label } from "@/components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import { useEnvironments } from "@/hooks/api/use-environments";
import {
	type OAuthGrant,
	useUpdateOAuthGrantEnvironment,
} from "@/hooks/api/use-oauth-grants";

export function OAuthGrantEnvironmentSelect({ grant }: { grant: OAuthGrant }) {
	const selectId = useId();
	const workspaceId = grant.workspace?.id;
	const environmentsQuery = useEnvironments(workspaceId);
	const environments = environmentsQuery.data ?? [];
	const update = useUpdateOAuthGrantEnvironment();

	if (!workspaceId) return null;

	const value = environments.some(
		(environment) => environment.id === grant.environment?.id,
	)
		? (grant.environment?.id ?? "")
		: "";

	return (
		<div className="mt-3 max-w-64 space-y-1.5">
			<Label htmlFor={selectId}>
				Environment for {grant.name ?? "this app"}
			</Label>
			<NativeSelect
				id={selectId}
				value={value}
				disabled={
					environmentsQuery.isLoading ||
					environments.length === 0 ||
					update.isPending
				}
				onChange={(event) => {
					if (!event.target.value) return;
					update.mutate({
						clientId: grant.clientId,
						workspaceId,
						environmentId: event.target.value,
					});
				}}
			>
				{value === "" ? (
					<NativeSelectOption value="" disabled>
						Choose an environment
					</NativeSelectOption>
				) : null}
				{environments.map((environment) => (
					<NativeSelectOption
						key={environment.id}
						value={environment.id}
						translate="no"
					>
						{environment.name}
						{environment.isDefault ? " (default)" : ""}
					</NativeSelectOption>
				))}
			</NativeSelect>
		</div>
	);
}
