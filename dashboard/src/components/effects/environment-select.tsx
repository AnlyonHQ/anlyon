import {
	Select,
	SelectItem,
	SelectPopup,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useEnvironments } from "@/hooks/api/use-environments";

const DEFAULT = "default";

export function EnvironmentSelect({
	workspaceId,
	value,
	onChange,
}: {
	workspaceId?: string;
	value: string | undefined;
	onChange: (environmentId: string | undefined) => void;
}) {
	const environments = useEnvironments(workspaceId).data ?? [];
	const items = [
		{ value: DEFAULT, label: "Default environment" },
		...environments.map((environment) => ({
			value: environment.id,
			label: environment.name,
		})),
	];

	return (
		<Select
			items={items}
			onValueChange={(next) =>
				onChange(
					typeof next === "string" && next !== DEFAULT ? next : undefined,
				)
			}
			value={value ?? DEFAULT}
		>
			<SelectTrigger aria-label="Environment" className="w-48">
				<SelectValue />
			</SelectTrigger>
			<SelectPopup>
				{items.map((item) => (
					<SelectItem key={item.value} value={item.value}>
						{item.label}
					</SelectItem>
				))}
			</SelectPopup>
		</Select>
	);
}
