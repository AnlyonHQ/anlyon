"use client";

import { isFeatureEnabled } from "@anlyon/feature-flags";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PackageOpen } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { PackPicker } from "@/components/actions/pack-picker";
import { ListFrame } from "@/components/layout/page";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogClose,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogPopup,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	SegmentedControl,
	type SegmentedOption,
} from "@/components/ui/segmented-control";
import { Spinner } from "@/components/ui/spinner";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { ApiError } from "@/lib/api-client";
import {
	BUNDLED_PACKS,
	CATALOGUE_PACKS,
	consoleTransport,
	installBundledPack,
	type PackCredentialMode,
	PackError,
	type PackInstallResult,
	type PackManifest,
	planBundledPack,
} from "@/lib/packs";

type Phase =
	| { step: "form" }
	| { step: "working" }
	| { step: "planned"; plan: PackInstallResult }
	| { step: "installed"; result: PackInstallResult }
	| { step: "error"; message: string };

const CREDENTIAL_OPTIONS: readonly SegmentedOption<PackCredentialMode>[] = [
	{ value: "connection", label: "Chosen at each call" },
	{ value: "secret", label: "Connected accounts by name" },
];

const OUTCOME_LABEL: Record<string, string> = {
	create: "Will create",
	created: "Created",
	skip: "Already there",
	update: "Will update",
	updated: "Updated",
	suggest: "Suggested only",
};

export function InstallPackDialog({
	workspaceId,
	packs = [...BUNDLED_PACKS, ...CATALOGUE_PACKS],
}: {
	workspaceId?: string;
	packs?: PackManifest[];
}) {
	const packFieldId = useId();
	const limitsId = useId();
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(false);
	const [packId, setPackId] = useState("");
	const [params, setParams] = useState<Record<string, string>>({});
	const [secrets, setSecrets] = useState<Record<string, string>>({});
	const [withLimits, setWithLimits] = useState(false);
	const [credential, setCredential] =
		useState<PackCredentialMode>("connection");
	const [phase, setPhase] = useState<Phase>({ step: "form" });

	const manifest = packs.find((pack) => pack.pack === packId);
	const staticSecrets = useMemo(
		() => manifest?.secrets.filter((secret) => secret.kind === "static") ?? [],
		[manifest],
	);

	const reset = () => {
		setPackId("");
		setParams({});
		setSecrets({});
		setWithLimits(false);
		setCredential("connection");
		setPhase({ step: "form" });
	};

	const options = () => ({
		params: Object.fromEntries(
			Object.entries(params).filter(([, v]) => v.trim() !== ""),
		),
		secrets: Object.fromEntries(
			Object.entries(secrets).filter(([, v]) => v !== ""),
		),
		withLimits,
		credential,
	});

	const describe = (error: unknown): string => {
		if (error instanceof PackError) return error.message;
		if (error instanceof ApiError)
			return error.code ? `${error.message} (${error.code})` : error.message;
		return "The pack could not be installed.";
	};

	const runPlan = async () => {
		if (!workspaceId || !manifest) return;
		setPhase({ step: "working" });
		try {
			const plan = await planBundledPack(
				consoleTransport(workspaceId),
				manifest,
				options(),
			);
			setPhase({ step: "planned", plan });
		} catch (error) {
			setPhase({ step: "error", message: describe(error) });
		}
	};

	const runInstall = async () => {
		if (!workspaceId || !manifest) return;
		setPhase({ step: "working" });
		try {
			const result = await installBundledPack(
				consoleTransport(workspaceId),
				manifest,
				options(),
			);
			setPhase({ step: "installed", result });
			await queryClient.invalidateQueries();
		} catch (error) {
			setPhase({ step: "error", message: describe(error) });
		}
	};

	const shown =
		phase.step === "planned"
			? phase.plan
			: phase.step === "installed"
				? phase.result
				: null;
	const connectFirst =
		phase.step === "planned"
			? phase.plan.steps.filter(
					(s) =>
						s.kind === "secret" &&
						s.outcome === "create" &&
						s.detail.startsWith("Connect"),
				)
			: [];

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) reset();
			}}
		>
			<DialogTrigger
				render={
					<Button size="sm" disabled={!workspaceId}>
						<PackageOpen className="size-4" aria-hidden="true" />
						Install a pack
					</Button>
				}
			/>
			<DialogPopup className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Install a pack</DialogTitle>
					<DialogDescription>
						A pack adds declared actions with read-backs, approval policies
						installed off, and suggested limits. Review the plan before anything
						is created.
					</DialogDescription>
				</DialogHeader>

				<DialogPanel className="space-y-4 py-2">
					<PackPicker
						packs={packs}
						value={packId}
						onChange={(next) => {
							setPackId(next);
							setParams({});
							setSecrets({});
							setPhase({ step: "form" });
						}}
					/>

					{manifest?.secrets.some((s) => s.kind === "connection") ? (
						<Field>
							<p className="font-medium text-sm">Accounts</p>
							<SegmentedControl
								label="Accounts"
								options={CREDENTIAL_OPTIONS}
								value={credential}
								onChange={(next) => {
									setCredential(next);
									setPhase({ step: "form" });
								}}
							/>
							<p className="text-muted-foreground text-xs">
								{credential === "connection"
									? "A call made for one of your users uses their own account. Other calls use this environment's connected account. Nothing needs connecting before install."
									: "Calls use the connected accounts the pack names, which must exist before install. A call made for one of your users still uses their own account."}
							</p>
						</Field>
					) : null}

					{manifest?.parameters?.map((param) => (
						<Field key={param.name}>
							<FieldLabel htmlFor={`${packFieldId}-${param.name}`}>
								{param.name}
							</FieldLabel>
							<Input
								id={`${packFieldId}-${param.name}`}
								name={param.name}
								autoComplete="off"
								spellCheck={false}
								className="font-mono"
								placeholder={param.default ?? ""}
								value={params[param.name] ?? ""}
								onChange={(e) => {
									setParams((p) => ({ ...p, [param.name]: e.target.value }));
									setPhase({ step: "form" });
								}}
							/>
							<p className="text-muted-foreground text-xs">
								{param.description}
							</p>
						</Field>
					))}

					{staticSecrets.map((secret) => (
						<Field key={secret.name}>
							<FieldLabel htmlFor={`${packFieldId}-secret-${secret.name}`}>
								{secret.name} (stored secret, used only if it does not exist)
							</FieldLabel>
							<Input
								id={`${packFieldId}-secret-${secret.name}`}
								type="password"
								autoComplete="off"
								className="font-mono"
								value={secrets[secret.name] ?? ""}
								onChange={(e) => {
									setSecrets((s) => ({ ...s, [secret.name]: e.target.value }));
									setPhase({ step: "form" });
								}}
							/>
							<p className="text-muted-foreground text-xs">
								{secret.description} Sent only to {secret.hosts.join(", ")}, in
								a header.
							</p>
						</Field>
					))}

					{manifest?.limits?.length ? (
						<div className="flex items-start gap-2">
							<Checkbox
								id={limitsId}
								checked={withLimits}
								onCheckedChange={(checked) => {
									setWithLimits(checked === true);
									setPhase({ step: "form" });
								}}
							/>
							<Label htmlFor={limitsId}>
								Create the suggested limits (needs permission to manage impact
								limits)
							</Label>
						</div>
					) : null}

					{phase.step === "working" ? (
						<p
							className="text-muted-foreground text-sm"
							role="status"
							aria-live="polite"
						>
							Working…
						</p>
					) : null}

					{phase.step === "error" ? (
						<Alert variant="error" role="alert">
							<AlertTitle>Nothing was installed</AlertTitle>
							<AlertDescription className="whitespace-pre-line">
								{phase.message}
							</AlertDescription>
						</Alert>
					) : null}

					{connectFirst.length > 0 ? (
						<Alert variant="warning" role="alert">
							<AlertTitle>Connect these accounts first</AlertTitle>
							<AlertDescription>
								{connectFirst.map((s) => s.name).join(", ")}.{" "}
								{isFeatureEnabled("connected-accounts") ? (
									<Link
										to="/integrations"
										className="underline underline-offset-2"
									>
										Integrations
									</Link>
								) : (
									"Connected accounts are not available yet."
								)}
							</AlertDescription>
						</Alert>
					) : null}

					{shown ? (
						<div className="space-y-2">
							{phase.step === "installed" ? (
								<Alert variant="success" role="status">
									<AlertTitle>Installed {shown.pack}</AlertTitle>
									<AlertDescription>
										{shown.disabledPolicies.length > 0
											? `Policies were installed off: ${shown.disabledPolicies.join("; ")}. Review and enable them under Approval Policies.`
											: "Nothing else to review."}
									</AlertDescription>
								</Alert>
							) : null}
							<ListFrame>
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>What</TableHead>
											<TableHead>Name</TableHead>
											<TableHead>Result</TableHead>
											<TableHead className="hidden md:table-cell">
												Detail
											</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{shown.steps.map((s) => (
											<TableRow key={`${s.kind}:${s.name}`}>
												<TableCell className="py-2 capitalize">
													{s.kind}
												</TableCell>
												<TableCell className="max-w-0 truncate py-2 font-mono text-xs">
													{s.name}
												</TableCell>
												<TableCell className="py-2">
													<Badge
														variant={
															s.outcome === "suggest"
																? "outline"
																: s.outcome === "skip"
																	? "secondary"
																	: "info"
														}
													>
														{s.kind === "connection"
															? "At each call"
															: (OUTCOME_LABEL[s.outcome] ?? s.outcome)}
													</Badge>
												</TableCell>
												<TableCell className="hidden max-w-0 truncate py-2 text-muted-foreground text-xs md:table-cell">
													{s.detail}
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							</ListFrame>
						</div>
					) : null}
				</DialogPanel>

				<DialogFooter>
					<DialogClose
						render={
							<Button variant="outline">
								{phase.step === "installed" ? "Close" : "Cancel"}
							</Button>
						}
					/>
					{phase.step === "planned" ? (
						<Button
							disabled={connectFirst.length > 0}
							onClick={() => void runInstall()}
						>
							Install
						</Button>
					) : phase.step !== "installed" ? (
						<Button
							disabled={!manifest || phase.step === "working"}
							onClick={() => void runPlan()}
						>
							{phase.step === "working" ? (
								<Spinner className="size-4" aria-hidden="true" />
							) : null}
							Review plan
						</Button>
					) : null}
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	);
}
