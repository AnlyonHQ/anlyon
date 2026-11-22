import { ArrowLeft, CornerDownLeft } from "lucide-react";
import {
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { useSaveWorkspaceDefaults } from "@/hooks/api/use-workspace-defaults";
import { redirectUrlProblem } from "@/lib/end-users";
import { cn } from "@/lib/utils";
import {
	actsForUsers,
	type DefaultsAnswers,
	initialAnswers,
	recommendedAnswers,
	saveFor,
} from "@/lib/workspace-defaults";
import {
	ActingForQuestion,
	AlwaysOnList,
	ChannelsQuestion,
	DeciderQuestion,
	RedirectQuestion,
	SomethingWrongQuestions,
	WindowQuestion,
} from "./questions";
import { useDefaultsSources } from "./use-defaults-sources";

const STEPS = [
	{
		title: "Who it's for",
		description:
			"About two minutes. Every answer starts on the recommended choice, and you can change any of them later in Settings, Defaults.",
	},
	{
		title: "Who decides",
		description: "When a call needs a yes before it runs.",
	},
	{
		title: "When something goes wrong",
		description: "What happens, and who hears about it.",
	},
] as const;

export function SetupJourney({
	workspaceId,
	workspaceName,
	onDone,
}: {
	workspaceId: string | undefined;
	workspaceName?: string;
	onDone: () => void;
}) {
	const sources = useDefaultsSources(workspaceId);
	const save = useSaveWorkspaceDefaults(workspaceId, {
		source: "setup_journey",
		successMessage: null,
	});
	const [answers, setAnswers] = useState<DefaultsAnswers | null>(null);
	const [step, setStep] = useState(0);
	const [redirectProblem, setRedirectProblem] = useState<string | null>(null);
	const headingId = useId();
	const bodyRef = useRef<HTMLDivElement>(null);
	const moved = useRef(false);

	const { defaults, preferences, environment } = sources;
	const ready = !sources.isLoading && defaults !== undefined;

	useEffect(() => {
		if (!ready || answers || !defaults) return;
		setAnswers(
			initialAnswers({
				defaults,
				preferences,
				environment,
				recommended: defaults.setup.status === null,
			}),
		);
	}, [ready, answers, defaults, preferences, environment]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: runs when the screen changes.
	useEffect(() => {
		if (!answers) return;
		const target =
			bodyRef.current?.querySelector<HTMLElement>(
				'[role="radio"][aria-checked="true"]',
			) ?? bodyRef.current?.querySelector<HTMLElement>("input, [role=radio]");
		if (moved.current || step === 0) target?.focus({ preventScroll: true });
		moved.current = false;
	}, [step, answers === null]);

	if (!ready || !answers || !defaults) {
		return (
			<JourneyShell step={step} workspaceName={workspaceName}>
				{sources.isError ? (
					<div className="flex flex-col items-start gap-3 py-10">
						<p className="text-[14px] text-muted-foreground">
							Your workspace's defaults could not be loaded.
						</p>
						<Button onClick={sources.refetch} size="sm" variant="outline">
							Try again
						</Button>
					</div>
				) : (
					<div aria-busy="true" className="flex flex-col gap-4 pt-2">
						<Skeleton className="h-4 w-24" />
						<Skeleton className="h-8 w-2/3" />
						<Skeleton className="h-48 w-full rounded-lg" />
					</div>
				)}
			</JourneyShell>
		);
	}

	if (sources.roleKnown && !sources.canEdit) {
		return (
			<JourneyShell step={step} workspaceName={workspaceName}>
				<div className="flex flex-col items-start gap-3 py-10">
					<h1 className="font-heading text-[1.5rem] leading-tight">
						An admin sets this workspace's defaults
					</h1>
					<p className="text-[14px] text-muted-foreground">
						You can see them in Settings, Defaults.
					</p>
					<Button onClick={onDone} size="sm">
						Continue to the console
					</Button>
				</div>
			</JourneyShell>
		);
	}

	const asksRedirect = sources.asksRedirect && actsForUsers(answers.actingFor);
	const saved = { defaults, preferences, environment };

	const finish = (final: DefaultsAnswers) => {
		const input = saveFor(final, saved);
		save.mutate(
			{
				...input,
				defaults: { ...input.defaults, setupStatus: "completed" },
			},
			{
				onSuccess: () => {
					toast.success("Defaults saved. Change them any time in Settings.");
					onDone();
				},
			},
		);
	};

	const goTo = (next: number) => {
		moved.current = true;
		setStep(next);
		document.documentElement.scrollTop = 0;
	};

	const next = () => {
		if (save.isPending) return;
		if (step === 0 && asksRedirect) {
			const typed = answers.redirectUrl.trim();
			const problem = typed ? redirectUrlProblem(typed) : null;
			if (problem) {
				setRedirectProblem(problem);
				bodyRef.current?.querySelector<HTMLInputElement>("input")?.focus();
				return;
			}
		}
		if (step < STEPS.length - 1) goTo(step + 1);
		else finish(answers);
	};

	const applyRecommended = () => {
		if (save.isPending) return;
		const recommended = recommendedAnswers(defaults, answers);
		const typed = recommended.redirectUrl.trim();
		if (typed && redirectUrlProblem(typed))
			recommended.redirectUrl = environment?.defaultRedirectUrl ?? "";
		setAnswers(recommended);
		finish(recommended);
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (
			event.key !== "Enter" ||
			event.shiftKey ||
			event.nativeEvent.isComposing
		)
			return;
		const target = event.target as HTMLElement;
		const role = target.getAttribute("role");
		if (target.closest("a")) return;
		if (target.tagName === "BUTTON" && role !== "radio" && role !== "checkbox")
			return;
		event.preventDefault();
		next();
	};

	const change = (updated: DefaultsAnswers) => {
		if (updated.redirectUrl !== answers.redirectUrl) setRedirectProblem(null);
		setAnswers(updated);
	};
	const common = { answers, onChange: change, disabled: save.isPending };
	const last = step === STEPS.length - 1;

	return (
		<JourneyShell step={step} workspaceName={workspaceName}>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: Enter continues from anywhere on the screen. */}
			<div className="flex flex-col" onKeyDown={onKeyDown} ref={bodyRef}>
				<p aria-live="polite" className="sr-only">
					Step {step + 1} of {STEPS.length}: {STEPS[step].title}
				</p>
				<section
					aria-labelledby={headingId}
					className="onboarding-enter flex flex-col"
					key={step}
				>
					<p className="ed-label text-muted-foreground">
						Step {step + 1} of {STEPS.length}
					</p>
					<h1
						className="mt-2 text-balance font-heading text-[1.625rem] leading-tight tracking-tight"
						id={headingId}
					>
						{STEPS[step].title}
					</h1>
					<p className="mt-1.5 max-w-[34rem] text-pretty text-[14px] text-muted-foreground leading-relaxed">
						{STEPS[step].description}
					</p>

					<div className="mt-7 flex flex-col gap-7">
						{step === 0 ? (
							<>
								<ActingForQuestion
									{...common}
									recommended={defaults.recommended.actingFor}
								/>
								{asksRedirect ? (
									<div className="onboarding-enter">
										<RedirectQuestion
											{...common}
											environment={environment}
											problem={redirectProblem}
										/>
									</div>
								) : null}
							</>
						) : step === 1 ? (
							<>
								{actsForUsers(answers.actingFor) ? (
									<DeciderQuestion {...common} />
								) : null}
								<WindowQuestion
									{...common}
									recommendedHours={defaults.recommended.approvalWindowHours}
								/>
								<ChannelsQuestion
									{...common}
									preferences={preferences}
									slack={sources.slack}
								/>
							</>
						) : (
							<>
								<SomethingWrongQuestions
									{...common}
									hasRedirect={Boolean(answers.redirectUrl.trim())}
								/>
								<div className="rounded-lg bg-muted/50 px-4 py-4 sm:px-5">
									<p className="ed-label mb-3 text-muted-foreground">
										Always on
									</p>
									<AlwaysOnList />
								</div>
							</>
						)}
					</div>
				</section>

				<footer className="sticky bottom-0 z-10 mt-10 flex flex-wrap items-center gap-2 border-t bg-background/90 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/75">
					<Button
						disabled={save.isPending}
						onClick={applyRecommended}
						size="sm"
						variant="ghost"
					>
						Use recommended
					</Button>
					<div className="ml-auto flex items-center gap-2">
						{step > 0 ? (
							<Button
								disabled={save.isPending}
								onClick={() => goTo(step - 1)}
								size="sm"
								variant="outline"
							>
								<ArrowLeft aria-hidden="true" />
								Back
							</Button>
						) : null}
						<Button loading={save.isPending} onClick={next} size="sm">
							{last ? "Save and finish" : "Continue"}
							<CornerDownLeft
								aria-hidden="true"
								className="hidden opacity-60 sm:block"
							/>
						</Button>
					</div>
				</footer>
			</div>
		</JourneyShell>
	);
}

function JourneyShell({
	step,
	workspaceName,
	children,
}: {
	step: number;
	workspaceName?: string;
	children: ReactNode;
}) {
	return (
		<div className="flex min-h-svh w-full min-w-0 flex-col items-center bg-background px-4 pt-6 sm:pt-12">
			<div className="flex w-full max-w-[36rem] min-w-0 flex-1 flex-col">
				<header className="flex items-center justify-between gap-4 pb-8 sm:pb-12">
					<div className="flex min-w-0 items-center gap-2.5">
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
						<span className="truncate text-[13px] text-muted-foreground">
							{workspaceName ? `${workspaceName} · Setup` : "Workspace setup"}
						</span>
					</div>
					<Progress step={step} />
				</header>
				<main className="flex min-w-0 flex-1 flex-col">{children}</main>
			</div>
		</div>
	);
}

function Progress({ step }: { step: number }) {
	return (
		<div className="flex shrink-0 items-center gap-3">
			<ol aria-label="Setup progress" className="flex items-center gap-1">
				{STEPS.map((item, index) => (
					<li
						aria-current={index === step ? "step" : undefined}
						className="flex items-center"
						key={item.title}
					>
						<span
							className={cn(
								"block h-[3px] w-6 rounded-full transition-colors duration-300",
								index <= step ? "bg-foreground" : "bg-border",
							)}
						/>
						<span className="sr-only">
							{item.title}
							{index < step ? ", done" : index === step ? ", current" : ""}
						</span>
					</li>
				))}
			</ol>
		</div>
	);
}
