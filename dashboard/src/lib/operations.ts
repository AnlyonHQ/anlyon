import {
	type PackLimit,
	type PackManifest,
	type PackParameter,
	type PackPolicy,
	packActionKind,
	packShortName,
} from "../../../sdks/typescript/sdk/src/resources/packs-core.ts";
import { installBundledPack, type OperationsApi } from "./packs";

export type OperationState = "absent" | "on" | "off";

export interface OperationRow {
	name: string;
	installedName: string;
	description: string;
	kind: "read" | "write";
	dimension: string | null;
	parameters: PackParameter[];
	state: OperationState;
}

export interface PolicyRow {
	name: string;
	actionName: string;
	condition: string | null;
	effect: PackPolicy["effect"];
	installed: { id: string; enabled: boolean } | null;
}

export interface LimitRow {
	name: string;
	actionName: string | null;
	dimension: string;
	currency: string | null;
	period: PackLimit["period"];
	suggestedAmount: number;
	created: boolean;
}

export interface OperationsView {
	pack: string;
	operations: OperationRow[];
	policies: PolicyRow[];
	limits: LimitRow[];
}

export function installedActionName(
	manifest: PackManifest,
	name: string,
): string {
	return `${packShortName(manifest.pack)}-${name}`;
}

export function connectionSecretOf(manifest: PackManifest): string | null {
	return manifest.secrets.find((s) => s.kind === "connection")?.name ?? null;
}

export async function readOperations(
	api: OperationsApi,
	manifest: PackManifest,
): Promise<OperationsView> {
	const operations: OperationRow[] = await Promise.all(
		manifest.actions.map(async (action) => {
			const installedName = installedActionName(manifest, action.name);
			const existing = (await api.getAction(installedName)) as {
				enabled?: boolean;
			} | null;
			const kind = packActionKind(action);
			const used = new Set(
				[
					...JSON.stringify(action).matchAll(
						/\{\{\s*param:([a-z][a-z0-9_]*)\s*\}\}/g,
					),
				].map((m) => m[1]),
			);
			return {
				name: action.name,
				installedName,
				description: action.description,
				kind,
				parameters: (manifest.parameters ?? []).filter((p) => used.has(p.name)),
				dimension:
					kind === "read"
						? null
						: "impact" in action && action.impact
							? action.impact.dimension
							: "money",
				state: !existing ? "absent" : existing.enabled === false ? "off" : "on",
			} satisfies OperationRow;
		}),
	);

	const policies: PolicyRow[] = [];
	for (const policy of manifest.policies ?? []) {
		if ((policy.effect as string) === "auto_approve") continue;
		const actionName = policy.matchActionName;
		const op = operations.find((o) => o.name === actionName);
		const found =
			op && op.state !== "absent"
				? (await api.listPolicies(op.installedName)).find(
						(p) => p.name === policy.name,
					)
				: undefined;
		policies.push({
			name: policy.name,
			actionName,
			condition: policy.condition ?? null,
			effect: policy.effect,
			installed: found ? { id: found.id, enabled: found.enabled } : null,
		});
	}

	const existingLimits = manifest.limits?.length ? await api.listLimits() : [];
	const limits: LimitRow[] = (manifest.limits ?? []).map((limit) => ({
		name: limit.name,
		actionName: limit.actionName ?? null,
		dimension: limit.dimension,
		currency: limit.currency ?? null,
		period: limit.period,
		suggestedAmount: limit.amount,
		created: existingLimits.some((l) => l.name === limit.name),
	}));

	return { pack: manifest.pack, operations, policies, limits };
}

export async function turnOperationOn(
	api: OperationsApi,
	manifest: PackManifest,
	row: OperationRow,
	secretName: string,
	params: Record<string, string> = {},
): Promise<void> {
	if (row.state === "off") {
		await api.updateAction(row.installedName, { enabled: true });
		return;
	}
	const packSecret = connectionSecretOf(manifest);
	await installBundledPack(api, manifest, {
		actions: [row.name],
		params,
		credential: "secret",
		...(packSecret && packSecret !== secretName
			? { secretNames: { [packSecret]: secretName } }
			: {}),
	});
}

export async function turnOperationsOn(
	api: OperationsApi,
	manifest: PackManifest,
	rows: OperationRow[],
	secretName: string,
	params: Record<string, string> = {},
): Promise<void> {
	for (const row of rows.filter((r) => r.state === "off")) {
		await api.updateAction(row.installedName, { enabled: true });
	}
	const absent = rows.filter((r) => r.state === "absent").map((r) => r.name);
	if (absent.length === 0) return;
	const packSecret = connectionSecretOf(manifest);
	await installBundledPack(api, manifest, {
		actions: absent,
		params,
		credential: "secret",
		...(packSecret && packSecret !== secretName
			? { secretNames: { [packSecret]: secretName } }
			: {}),
	});
}

export async function turnOperationOff(
	api: OperationsApi,
	row: OperationRow,
): Promise<void> {
	await api.updateAction(row.installedName, { enabled: false });
}

export async function enablePolicy(
	api: OperationsApi,
	manifest: PackManifest,
	row: PolicyRow,
): Promise<void> {
	if (!row.installed) return;
	await api.updatePolicy(row.installed.id, {
		enabled: true,
		changeNote: `Enabled from the operations screen of ${manifest.pack}`,
	});
}

export async function createOperationLimit(
	api: OperationsApi,
	manifest: PackManifest,
	row: LimitRow,
	amount: number,
): Promise<void> {
	await api.createLimit({
		name: row.name,
		dimension: row.dimension,
		...(row.currency ? { currency: row.currency } : {}),
		period: row.period,
		amount,
		actionName: row.actionName
			? installedActionName(manifest, row.actionName)
			: null,
	} as Parameters<OperationsApi["createLimit"]>[0]);
}
