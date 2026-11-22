import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, ChevronDown } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsiblePanel,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
	createSetupOwner,
	type InstanceSetting,
	type InstanceSettingGroup,
	instanceKeys,
	isForbidden,
	useInstanceSettings,
	useInstanceStatus,
	useSetupPending,
	verifySetupToken,
} from "@/hooks/api/use-instance";
import { ApiError } from "@/lib/api-client";
import { authClient } from "@/lib/auth-client";
import {
	groupStatus,
	type OwnerFields,
	ownerProblems,
} from "@/lib/instance-onboarding";
import { cn } from "@/lib/utils";
import {
	GROUPS,
	GroupExtras,
	RootKeyBackup,
	SettingGroupForm,
	StatusText,
} from "./instance-settings";
import { SystemStatus } from "./system-status";

export type Phase = "owner" | "root-key" | "configure" | "done";

const STEPS: { phase: Phase; label: string }[] = [
	{ phase: "owner", label: "Owner" },
	{ phase: "root-key", label: "Root key" },
	{ phase: "configure", label: "Settings" },
	{ phase: "done", label: "Ready" },
];

export const OPTIONAL_GROUPS: InstanceSettingGroup[] = [
	"email",
	"storage",
	"accounts",
	"license",
	"telemetry",
	"oauth",
	"slack",
];

let tokenFromUrl: string | null = null;
export function readTokenFromUrl(): string {
	if (tokenFromUrl !== null) return tokenFromUrl;
	if (typeof window === "undefined") return "";
	const fromHash = new URLSearchParams(
		window.location.hash.replace(/^#/, ""),
	).get("token");
	tokenFromUrl = fromHash ?? "";
	return tokenFromUrl;
}

function useForgetTokenInUrl() {
	useEffect(() => {
		if (/(^|[#&])token=/.test(window.location.hash))
			window.history.replaceState(
				null,
				"",
				window.location.pathname + window.location.search,
			);
	}, []);
}

export function SetupWizard() {
	const [token] = useState(readTokenFromUrl);
	useForgetTokenInUrl();
	const [phase, setPhase] = useState<Phase | null>(null);
	const [workspaceName, setWorkspaceName] = useState<string | null>(null);
	const [email, setEmail] = useState<string | undefined>();
	const pending = useSetupPending();
	const status = useInstanceStatus(pending.data === false || phase !== null);
	const signedInAdmin = Boolean(status.data);
	const settings = useInstanceSettings(signedInAdmin);

	const resolved: Phase | "set-up" | "loading" =
		phase ??
		(pending.isLoading
			? "loading"
			: pending.data
				? "owner"
				: status.isLoading
					? "loading"
					: status.data && !status.data.rootKey.backupConfirmedAt
						? "root-key"
						: "set-up");

	return (
		<div className="flex min-h-svh w-full min-w-0 flex-col items-center bg-background px-4 py-8 sm:py-14">
			<div className="flex w-full max-w-[34rem] min-w-0 flex-col gap-4">
				<header className="flex items-center justify-between gap-4 pb-2">
					<div className="flex items-center gap-2.5">
						<img
							alt=""
							className="size-5 dark:hidden"
							src="/logo-light-v2.png"
						/>
						<img
							alt=""
							className="hidden size-5 dark:block"
							src="/logo-dark-v2.png"
						/>
						<span className="font-medium text-[14px]">Anlyon</span>
						<span className="text-[13px] text-muted-foreground">
							Server setup
						</span>
					</div>
					{resolved !== "loading" && resolved !== "set-up" ? (
						<StepIndicator current={resolved} />
					) : null}
				</header>

				<SystemStatus settings={settings.data} />

				<main className="onboarding-enter" key={resolved}>
					{resolved === "loading" ? (
						<Skeleton className="h-96 w-full" />
					) : resolved === "owner" ? (
						<OwnerStep
							initialToken={token}
							onDone={(created) => {
								setWorkspaceName(created.workspaceName);
								setEmail(created.email);
								setPhase("root-key");
							}}
						/>
					) : resolved === "root-key" ? (
						<RootKeyStep onDone={() => setPhase("configure")} />
					) : resolved === "configure" ? (
						<ConfigureStep email={email} onDone={() => setPhase("done")} />
					) : resolved === "done" ? (
						<DoneStep workspaceName={workspaceName} />
					) : (
						<AlreadySetUp
							signedIn={signedInAdmin || isForbidden(status.error)}
						/>
					)}
				</main>

				{resolved !== "done" && resolved !== "set-up" ? (
					<p className="text-center text-[12px] text-muted-foreground">
						Every setting stays editable in Settings, Instance.
					</p>
				) : null}
			</div>
		</div>
	);
}

function StepIndicator({ current }: { current: Phase }) {
	const index = STEPS.findIndex((step) => step.phase === current);
	return (
		<div className="flex items-center gap-3">
			<span
				aria-hidden="true"
				className="font-mono text-[12px] text-muted-foreground tabular-nums"
			>
				{index + 1}/{STEPS.length}
			</span>
			<ol aria-label="Setup steps" className="flex items-center gap-1">
				{STEPS.map((step, i) => (
					<li
						aria-current={i === index ? "step" : undefined}
						className="flex items-center"
						key={step.phase}
					>
						<span
							className={cn(
								"block h-[3px] w-5 transition-colors duration-300",
								i <= index ? "bg-foreground" : "bg-border",
							)}
						/>
						<span className="sr-only">
							{step.label}
							{i < index ? ", done" : i === index ? ", current" : ""}
						</span>
					</li>
				))}
			</ol>
		</div>
	);
}

function StepCard({
	step,
	title,
	description,
	children,
	footer,
}: {
	step?: Phase;
	title: string;
	description?: ReactNode;
	children: ReactNode;
	footer?: ReactNode;
}) {
	const titleId = useId();
	const index = step ? STEPS.findIndex((s) => s.phase === step) : -1;
	return (
		<section
			aria-labelledby={titleId}
			className="border bg-card text-card-foreground"
		>
			<div className="px-6 pt-6 sm:px-8 sm:pt-7">
				{index >= 0 ? (
					<p className="ed-label text-muted-foreground">
						Step {index + 1} · {STEPS[index]!.label}
					</p>
				) : null}
				<h1
					className="mt-2 text-balance text-[1.625rem] leading-tight"
					id={titleId}
				>
					{title}
				</h1>
				{description ? (
					<p className="mt-2 text-pretty text-[14px] text-muted-foreground leading-relaxed">
						{description}
					</p>
				) : null}
			</div>
			<div className="px-6 py-6 sm:px-8">{children}</div>
			{footer ? (
				<div className="flex items-center justify-end gap-2 border-t bg-muted/30 px-6 py-3 sm:px-8">
					{footer}
				</div>
			) : null}
		</section>
	);
}

function OwnerField({
	id,
	label,
	hint,
	error,
	children,
}: {
	id: string;
	label: string;
	hint?: ReactNode;
	error?: string;
	children: ReactNode;
}) {
	return (
		<div className="flex flex-col gap-1.5">
			<label className="font-medium text-[13px]" htmlFor={id}>
				{label}
			</label>
			{children}
			<p
				className={cn(
					"min-h-4 text-[12px]",
					error ? "text-destructive-foreground" : "text-muted-foreground",
				)}
				id={`${id}-hint`}
			>
				{error ?? hint}
			</p>
		</div>
	);
}

function OwnerStep({
	initialToken,
	onDone,
}: {
	initialToken: string;
	onDone: (created: { workspaceName: string | null; email: string }) => void;
}) {
	const queryClient = useQueryClient();
	const [token, setToken] = useState(initialToken);
	const [fields, setFields] = useState<OwnerFields>({
		name: "",
		email: "",
		password: "",
		confirm: "",
	});
	const [workspaceName, setWorkspaceName] = useState("");
	const [touched, setTouched] = useState<Partial<Record<string, boolean>>>({});
	const [submitted, setSubmitted] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const formRef = useRef<HTMLFormElement>(null);

	const problems = ownerProblems(fields);
	const tokenProblem = token.trim() ? undefined : "Paste the setup token";
	const shown = (key: keyof OwnerFields | "token") =>
		submitted || touched[key]
			? key === "token"
				? tokenProblem
				: problems[key]
			: undefined;
	const field = (key: keyof OwnerFields) => ({
		value: fields[key],
		onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
			setFields((previous) => ({ ...previous, [key]: event.target.value })),
		onBlur: () => setTouched((previous) => ({ ...previous, [key]: true })),
		"aria-invalid": shown(key) ? true : undefined,
		"aria-describedby": `owner-${key}-hint`,
	});

	async function submit(event: React.FormEvent) {
		event.preventDefault();
		setSubmitted(true);
		if (Object.keys(problems).length > 0 || tokenProblem) {
			formRef.current
				?.querySelector<HTMLInputElement>("[aria-invalid='true']")
				?.focus();
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const { valid } = await verifySetupToken(token.trim());
			if (!valid) {
				setError(
					"That setup token is not this server's. Use the setup URL the installer printed, or the one in the server log.",
				);
				return;
			}
			const email = fields.email.trim();
			await createSetupOwner({
				token: token.trim(),
				name: fields.name.trim(),
				email,
				password: fields.password,
				...(workspaceName.trim()
					? { workspaceName: workspaceName.trim() }
					: {}),
			});
			const signedIn = await authClient.signIn.email({
				email,
				password: fields.password,
			});
			if (signedIn.error) {
				setError(
					`Your account was created, but signing in failed: ${signedIn.error.message}. Sign in from the login page.`,
				);
				return;
			}
			await queryClient.invalidateQueries({ queryKey: ["auth"] });
			queryClient.setQueryData(instanceKeys.setup, false);
			onDone({ workspaceName: workspaceName.trim() || null, email });
		} catch (caught) {
			setError(
				caught instanceof ApiError || caught instanceof Error
					? caught.message
					: "Setup failed. Nothing was saved.",
			);
		} finally {
			setBusy(false);
		}
	}

	const passwordHint =
		fields.password.length >= 12
			? "Long enough"
			: fields.password.length > 0
				? `${12 - fields.password.length} more ${12 - fields.password.length === 1 ? "character" : "characters"}`
				: "At least 12 characters";

	return (
		<StepCard
			description="The first account on this server. It owns the first workspace and can change the server's settings."
			footer={
				<Button form="owner-form" loading={busy} type="submit">
					Create owner
					<ArrowRight data-icon="inline-end" />
				</Button>
			}
			step="owner"
			title="Create the owner"
		>
			<form
				className="flex flex-col gap-3"
				id="owner-form"
				noValidate
				onSubmit={submit}
				ref={formRef}
			>
				{initialToken ? (
					<p className="mb-2 inline-flex items-center gap-2 text-[12px] text-muted-foreground">
						<span
							aria-hidden="true"
							className="inline-block size-1.5 rounded-full bg-success"
						/>
						Setup token read from the link. It works once.
					</p>
				) : (
					<OwnerField
						error={shown("token")}
						hint="Printed by the installer, and written to the server log at start."
						id="owner-token"
						label="Setup token"
					>
						<Input
							aria-describedby="owner-token-hint"
							aria-invalid={shown("token") ? true : undefined}
							autoComplete="off"
							className="font-mono"
							id="owner-token"
							onBlur={() => setTouched((p) => ({ ...p, token: true }))}
							onChange={(event) => setToken(event.target.value)}
							spellCheck={false}
							value={token}
						/>
					</OwnerField>
				)}
				<div className="grid gap-3 sm:grid-cols-2">
					<OwnerField error={shown("name")} id="owner-name" label="Your name">
						<Input autoComplete="name" id="owner-name" {...field("name")} />
					</OwnerField>
					<OwnerField error={shown("email")} id="owner-email" label="Email">
						<Input
							autoComplete="email"
							id="owner-email"
							type="email"
							{...field("email")}
						/>
					</OwnerField>
				</div>
				<div className="grid gap-3 sm:grid-cols-2">
					<OwnerField
						error={shown("password")}
						hint={passwordHint}
						id="owner-password"
						label="Password"
					>
						<Input
							autoComplete="new-password"
							id="owner-password"
							type="password"
							{...field("password")}
						/>
					</OwnerField>
					<OwnerField
						error={shown("confirm")}
						hint={
							fields.confirm && fields.confirm === fields.password
								? "Matches"
								: undefined
						}
						id="owner-confirm"
						label="Confirm password"
					>
						<Input
							autoComplete="new-password"
							id="owner-confirm"
							type="password"
							{...field("confirm")}
						/>
					</OwnerField>
				</div>
				<OwnerField
					hint="Optional. You can rename it later."
					id="owner-workspace"
					label="Workspace name"
				>
					<Input
						aria-describedby="owner-workspace-hint"
						id="owner-workspace"
						onChange={(event) => setWorkspaceName(event.target.value)}
						placeholder="Acme"
						value={workspaceName}
					/>
				</OwnerField>
				{error ? (
					<p
						className="onboarding-enter border border-destructive/30 bg-destructive/5 px-3 py-2 text-[13px] text-destructive-foreground"
						role="alert"
					>
						{error}
					</p>
				) : null}
			</form>
		</StepCard>
	);
}

function RootKeyStep({ onDone }: { onDone: () => void }) {
	const status = useInstanceStatus();
	if (!status.data) return <Skeleton className="h-96 w-full" />;
	const confirmed =
		Boolean(status.data.rootKey.backupConfirmedAt) ||
		!status.data.rootKey.inUse;
	return (
		<StepCard
			description="Every key this server uses comes from one root key. Keep a copy before anything is stored here."
			footer={
				confirmed ? (
					<Button onClick={onDone}>
						Continue
						<ArrowRight data-icon="inline-end" />
					</Button>
				) : undefined
			}
			step="root-key"
			title="Keep a copy of the root key"
		>
			<RootKeyBackup
				confirmLabel="Continue"
				onConfirmed={onDone}
				status={status.data}
			/>
		</StepCard>
	);
}

function ConfigureStep({
	email,
	onDone,
}: {
	email?: string;
	onDone: () => void;
}) {
	const settings = useInstanceSettings();
	const [configuring, setConfiguring] = useState(false);
	const [open, setOpen] = useState<InstanceSettingGroup | null>(null);
	if (!settings.data) return <Skeleton className="h-96 w-full" />;
	const list: InstanceSetting[] = settings.data;
	return (
		<StepCard
			description={
				configuring
					? "Open a group to change it. Each one saves on its own."
					: "This server starts with safe defaults. Configure what you need now, or do it later."
			}
			footer={
				configuring ? (
					<Button onClick={onDone}>
						Finish
						<ArrowRight data-icon="inline-end" />
					</Button>
				) : (
					<>
						<Button onClick={onDone} variant="ghost">
							Later
						</Button>
						<Button
							onClick={() => {
								setConfiguring(true);
								setOpen("email");
							}}
						>
							Configure now
						</Button>
					</>
				)
			}
			step="configure"
			title="Optional settings"
		>
			<ul className="-my-1 divide-y border-y">
				{OPTIONAL_GROUPS.map((group) => {
					const status = groupStatus(group, list);
					if (!configuring) {
						return (
							<li
								className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5"
								key={group}
							>
								<span className="font-medium text-[13px]">
									{GROUPS[group].title}
								</span>
								<StatusText compact status={status} />
							</li>
						);
					}
					return (
						<li key={group}>
							<Collapsible
								onOpenChange={(next) => setOpen(next ? group : null)}
								open={open === group}
							>
								<CollapsibleTrigger className="group flex w-full items-center justify-between gap-4 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
									<span className="font-medium text-[13px]">
										{GROUPS[group].title}
									</span>
									<span className="flex min-w-0 items-center gap-3">
										<StatusText compact status={status} />
										<ChevronDown
											aria-hidden="true"
											className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[panel-open]:rotate-180"
										/>
									</span>
								</CollapsibleTrigger>
								<CollapsiblePanel>
									<div className="flex flex-col gap-4 pt-1 pb-5">
										<p className="text-[13px] text-muted-foreground">
											{GROUPS[group].description}
										</p>
										<SettingGroupForm group={group} settings={list}>
											{(unsaved) => (
												<GroupExtras
													email={email}
													group={group}
													unsaved={unsaved}
												/>
											)}
										</SettingGroupForm>
									</div>
								</CollapsiblePanel>
							</Collapsible>
						</li>
					);
				})}
			</ul>
		</StepCard>
	);
}

function DoneStep({ workspaceName }: { workspaceName: string | null }) {
	const start = useRef<HTMLAnchorElement>(null);
	useEffect(() => {
		start.current?.focus();
	}, []);
	return (
		<section
			aria-labelledby="setup-ready"
			className="border bg-card px-6 py-10 text-center text-card-foreground sm:px-10"
		>
			<svg
				aria-hidden="true"
				className="mx-auto size-10 text-success"
				fill="none"
				viewBox="0 0 40 40"
			>
				<circle
					className="text-border"
					cx="20"
					cy="20"
					r="19"
					stroke="currentColor"
				/>
				<path
					className="onboarding-draw"
					d="M13 20.5l4.5 4.5L27 15.5"
					stroke="currentColor"
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeWidth="2"
					style={{ "--draw-length": 22 } as React.CSSProperties}
				/>
			</svg>
			<h1 className="mt-5 text-[1.75rem] leading-tight" id="setup-ready">
				You're ready.
			</h1>
			<p className="mx-auto mt-2 max-w-[26rem] text-pretty text-[14px] text-muted-foreground leading-relaxed">
				{workspaceName ? `${workspaceName} is` : "Your workspace is"} set up on
				this server. Next, connect a tool and watch your agent's first call wait
				for your approval. About two minutes.
			</p>
			<div className="mt-7 flex flex-col items-center justify-center gap-2 sm:flex-row">
				<Button render={<Link ref={start} to="/get-started" />} size="lg">
					Run a first approval
					<ArrowRight data-icon="inline-end" />
				</Button>
				<Button render={<Link to="/dashboard" />} size="lg" variant="ghost">
					Go to Home
				</Button>
			</div>
			<p className="mt-8 text-[12px] text-muted-foreground">
				Invite your team from Settings, Team. Server settings are in Settings,
				Instance.
			</p>
		</section>
	);
}

function AlreadySetUp({ signedIn }: { signedIn: boolean }) {
	return (
		<StepCard
			description={
				signedIn
					? "Change this server's settings in Settings, Instance."
					: "Sign in to use it. An instance admin changes its settings in Settings, Instance."
			}
			footer={
				signedIn ? (
					<Button render={<Link to="/dashboard" />}>Open the console</Button>
				) : (
					<Button render={<Link to="/auth/login" />}>Sign in</Button>
				)
			}
			title="This server is set up"
		>
			<p className="text-[13px] text-muted-foreground">
				The setup link works once, for the first owner.
			</p>
		</StepCard>
	);
}
