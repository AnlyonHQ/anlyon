import { Link } from "@tanstack/react-router";
import {
	Ban,
	Check,
	EyeOff,
	KeyRound,
	PlugZap,
	ReceiptText,
	ShieldCheck,
} from "lucide-react";
import { type ReactNode, useId } from "react";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import type {
	ActingFor,
	ApprovalDecider,
	Environment,
	IntegrationConnection,
	NotificationPreferences,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import {
	actsForTeam,
	actsForUsers,
	type DefaultsAnswers,
	RECOMMENDED_DECIDER,
	windowLabel,
	windowOptions,
	withActingFor,
	withDecider,
} from "@/lib/workspace-defaults";
import {
	type Choice,
	ChoiceList,
	type ChoiceListVariant,
	FixedRow,
	RecommendedMark,
	ToggleRow,
} from "./choice-list";

export interface QuestionProps {
	answers: DefaultsAnswers;
	onChange: (answers: DefaultsAnswers) => void;
	disabled?: boolean;
	variant?: ChoiceListVariant;
}

export function Question({
	title,
	hint,
	variant = "bordered",
	children,
	id,
}: {
	title: ReactNode;
	hint?: ReactNode;
	variant?: ChoiceListVariant;
	children: (titleId: string) => ReactNode;
	id?: string;
}) {
	const generated = useId();
	const titleId = id ?? generated;
	return (
		<div
			className={cn(
				"flex min-w-0 flex-col",
				variant === "bordered" ? "gap-2.5" : "gap-0",
			)}
		>
			<div className={cn(variant === "flush" && "px-5 pt-4 pb-3")}>
				<p
					className="text-pretty font-medium text-[14px] text-foreground leading-5"
					id={titleId}
				>
					{title}
				</p>
				{hint ? (
					<p className="mt-0.5 text-pretty text-[12.5px] text-muted-foreground leading-relaxed">
						{hint}
					</p>
				) : null}
			</div>
			{children(titleId)}
		</div>
	);
}

const ACTING_FOR_CHOICES: {
	value: ActingFor;
	label: string;
	consequence: string;
}[] = [
	{
		value: "team",
		label: "Me and my team",
		consequence:
			"It works in accounts your workspace connects, like your own Stripe or GitHub.",
	},
	{
		value: "users",
		label: "My users",
		consequence:
			"Each person using your app connects their own accounts, and it works in theirs.",
	},
	{
		value: "both",
		label: "Both",
		consequence: "Accounts your workspace connects, and each user's own.",
	},
];

export function ActingForQuestion({
	answers,
	onChange,
	disabled,
	variant,
	recommended,
}: QuestionProps & { recommended: ActingFor }) {
	return (
		<Question
			hint="The questions that follow depend on it."
			title="Who will your agent act for?"
			variant={variant}
		>
			{(titleId) => (
				<ChoiceList
					choices={ACTING_FOR_CHOICES.map((choice) => ({
						...choice,
						recommended: choice.value === recommended,
					}))}
					disabled={disabled}
					labelledBy={titleId}
					onChange={(value) => onChange(withActingFor(answers, value))}
					value={answers.actingFor}
					variant={variant}
				/>
			)}
		</Question>
	);
}

export function RedirectQuestion({
	answers,
	onChange,
	disabled,
	variant = "bordered",
	environment,
	problem,
}: QuestionProps & {
	environment: Environment | undefined;
	problem: string | null;
}) {
	const inputId = useId();
	const saved = environment?.defaultRedirectUrl ?? "";
	return (
		<Question
			hint={
				<>
					Connect links send people back here when your server does not pass its
					own URL. Optional.
					{environment
						? ` Set for ${environment.name}; other environments are in `
						: " It lives in "}
					<Link
						className="text-foreground underline underline-offset-2 hover:no-underline"
						to="/integrations/settings"
					>
						Connect settings
					</Link>
					.
				</>
			}
			title="Where do users land after connecting an account?"
			variant={variant}
		>
			{(titleId) => (
				<div className={cn(variant === "flush" && "px-5 pb-4")}>
					<Input
						aria-describedby={problem ? `${inputId}-problem` : undefined}
						aria-invalid={problem ? true : undefined}
						aria-labelledby={titleId}
						autoComplete="off"
						className="font-mono text-[13px]"
						disabled={disabled}
						id={inputId}
						inputMode="url"
						onChange={(event) =>
							onChange({ ...answers, redirectUrl: event.target.value })
						}
						placeholder="https://app.example.com/settings/connections"
						spellCheck={false}
						translate="no"
						value={answers.redirectUrl}
					/>
					<p
						className={cn(
							"mt-1.5 min-h-4 text-[12px]",
							problem ? "text-destructive-foreground" : "text-muted-foreground",
						)}
						id={problem ? `${inputId}-problem` : undefined}
						role={problem ? "alert" : undefined}
					>
						{problem ??
							(answers.redirectUrl.trim()
								? null
								: saved
									? "Leave it empty to remove it."
									: "Without one, your server passes a URL with each link.")}
					</p>
				</div>
			)}
		</Question>
	);
}

const END_USER_APPROVALS_DOCS =
	"https://docs.anlyon.com/guides/act-for-your-users#8-approve-in-your-own-ui";

export function DeciderQuestion({
	answers,
	onChange,
	disabled,
	variant,
}: QuestionProps) {
	const choices: Choice<ApprovalDecider>[] = [
		{
			value: "team",
			label: "Your team decides",
			consequence:
				"It comes to your team's Approvals inbox, like your own calls.",
			recommended: RECOMMENDED_DECIDER === "team",
		},
		{
			value: "end_user",
			label: "The user decides",
			consequence:
				"They approve or deny it themselves. It stays out of your team's inbox.",
			note: (
				<>
					Their requests appear only in your app, so your app needs an approval
					screen.{" "}
					<a
						className="whitespace-nowrap text-foreground underline underline-offset-2 hover:no-underline"
						href={END_USER_APPROVALS_DOCS}
						rel="noreferrer"
						target="_blank"
					>
						How to add one
					</a>
				</>
			),
			recommended: RECOMMENDED_DECIDER === "end_user",
		},
	];
	return (
		<Question
			hint="A policy that says who decides always wins."
			title="If a call for one of your users needs a yes, and no policy says who decides…"
			variant={variant}
		>
			{(titleId) => (
				<ChoiceList
					choices={choices}
					disabled={disabled}
					labelledBy={titleId}
					onChange={(value) => onChange(withDecider(answers, value))}
					value={answers.endUserDecider}
					variant={variant}
				/>
			)}
		</Question>
	);
}

export function WindowQuestion({
	answers,
	onChange,
	disabled,
	variant = "bordered",
	recommendedHours,
}: QuestionProps & { recommendedHours: number }) {
	const options = windowOptions(recommendedHours, answers.approvalWindowHours);
	const hours = answers.approvalWindowHours;
	const isRecommended = hours === recommendedHours;
	return (
		<Question
			title="How long does a request wait for an answer?"
			variant={variant}
		>
			{() => (
				<div
					className={cn(
						"flex flex-col gap-2",
						variant === "flush" && "px-5 pb-4",
					)}
				>
					<div
						aria-disabled={disabled || undefined}
						className={cn(
							"min-w-0 overflow-x-auto",
							disabled && "pointer-events-none opacity-60",
						)}
					>
						<SegmentedControl
							className="inline-flex h-8 shrink-0 items-center gap-0.5 rounded-md bg-muted p-0.5"
							label="How long does a request wait for an answer?"
							onChange={(value) =>
								onChange({ ...answers, approvalWindowHours: value })
							}
							options={options.map((value) => ({
								value,
								label: windowLabel(value),
							}))}
							segmentClassName={(_, checked) =>
								cn(
									"h-7 whitespace-nowrap rounded-[5px] px-2 text-[12.5px] sm:px-2.5 tabular-nums outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring",
									checked
										? "bg-background font-medium text-foreground shadow-xs"
										: "text-muted-foreground hover:text-foreground",
								)
							}
							value={hours}
						/>
					</div>
					<p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted-foreground">
						<span>
							If nobody answers in {windowLabel(hours)}, the request expires and
							nothing is sent.
						</span>
						{isRecommended ? (
							<RecommendedMark />
						) : disabled ? null : (
							<button
								className="rounded-sm text-foreground underline underline-offset-2 outline-none hover:no-underline focus-visible:ring-2 focus-visible:ring-ring"
								onClick={() =>
									onChange({
										...answers,
										approvalWindowHours: recommendedHours,
									})
								}
								type="button"
							>
								Use {windowLabel(recommendedHours)} (recommended)
							</button>
						)}
					</p>
				</div>
			)}
		</Question>
	);
}

function listOf(emails: string[]): string {
	if (emails.length === 0) return "";
	if (emails.length === 1) return emails[0];
	return `${emails[0]} and ${emails.length - 1} more`;
}

export function ChannelsQuestion({
	answers,
	onChange,
	disabled,
	variant = "bordered",
	preferences,
	slack,
}: QuestionProps & {
	preferences: NotificationPreferences | undefined;
	slack: IntegrationConnection | undefined;
}) {
	const recipients = preferences?.emailRecipients ?? [];
	const settingsLink = (to: string, label: string) => (
		<Link
			className="rounded-sm text-[12.5px] text-muted-foreground underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
			to={to}
		>
			{label}
		</Link>
	);
	return (
		<Question
			hint="These channels carry every workspace alert, including the ones for when something goes wrong."
			title="When a request needs your team, where do they hear about it?"
			variant={variant}
		>
			{() => (
				<div
					className={cn(
						variant === "bordered"
							? "overflow-hidden rounded-lg border divide-y divide-border/70"
							: "divide-y divide-border/70 border-t border-border/70",
					)}
				>
					<FixedRow
						consequence="Approvals and the bell, for everyone in the workspace."
						icon={<Check />}
						label="In the console"
						variant={variant}
					/>
					<ToggleRow
						checked={answers.emailAlerts}
						consequence={
							recipients.length > 0
								? `Sent to ${listOf(recipients)}.`
								: "No recipients yet. Add them in Notifications."
						}
						disabled={disabled}
						label="Email"
						onChange={(emailAlerts) => onChange({ ...answers, emailAlerts })}
						trailing={settingsLink("/settings/notifications", "Recipients")}
						variant={variant}
					/>
					{slack ? (
						<ToggleRow
							checked={answers.slackAlerts}
							consequence={
								slack.slackChannelName
									? `Posted to #${slack.slackChannelName.replace(/^#/, "")}.`
									: "Posted to your connected Slack channel."
							}
							disabled={disabled}
							label="Slack"
							onChange={(slackAlerts) => onChange({ ...answers, slackAlerts })}
							variant={variant}
						/>
					) : (
						<div
							className={cn(
								"flex items-center justify-between gap-3 py-3",
								variant === "bordered" ? "px-3.5" : "px-5",
							)}
						>
							<span className="flex min-w-0 flex-col gap-0.5 pl-7">
								<span className="text-[13.5px] leading-5">Slack</span>
								<span className="text-[12.5px] text-muted-foreground">
									Not connected.
								</span>
							</span>
							{settingsLink("/settings/integrations", "Connect Slack")}
						</div>
					)}
				</div>
			)}
		</Question>
	);
}

type Tell = "tell" | "quiet";
const tell = (on: boolean): Tell => (on ? "tell" : "quiet");

function TellQuestion({
	title,
	hint,
	value,
	onChange,
	tellLabel,
	tellConsequence,
	quietLabel,
	quietConsequence,
	disabled,
	variant,
}: {
	title: string;
	hint?: ReactNode;
	value: boolean;
	onChange: (value: boolean) => void;
	tellLabel: string;
	tellConsequence: string;
	quietLabel: string;
	quietConsequence: string;
	disabled?: boolean;
	variant?: ChoiceListVariant;
}) {
	return (
		<Question hint={hint} title={title} variant={variant}>
			{(titleId) => (
				<ChoiceList<Tell>
					choices={[
						{
							value: "tell",
							label: tellLabel,
							consequence: tellConsequence,
							recommended: true,
						},
						{
							value: "quiet",
							label: quietLabel,
							consequence: quietConsequence,
						},
					]}
					disabled={disabled}
					labelledBy={titleId}
					onChange={(next) => onChange(next === "tell")}
					value={tell(value)}
					variant={variant}
				/>
			)}
		</Question>
	);
}

export function LimitStatement({
	variant = "bordered",
}: {
	variant?: ChoiceListVariant;
}) {
	return (
		<Question title="If a call would go over a limit…" variant={variant}>
			{() => (
				<div
					className={cn(
						variant === "bordered"
							? "overflow-hidden rounded-lg border"
							: "border-t border-border/70",
					)}
				>
					<FixedRow
						consequence="Nothing is sent, and your agent is told which limit stopped it."
						icon={<Ban />}
						label="It is refused"
						variant={variant}
					/>
				</div>
			)}
		</Question>
	);
}

export function SomethingWrongQuestions({
	answers,
	onChange,
	disabled,
	variant = "bordered",
	hasRedirect,
}: QuestionProps & { hasRedirect: boolean }) {
	return (
		<>
			<LimitStatement variant={variant} />
			<TellQuestion
				disabled={disabled}
				onChange={(tellOnUnknown) => onChange({ ...answers, tellOnUnknown })}
				quietConsequence="It waits in Receipts, marked unknown, until someone records what happened."
				quietLabel="Leave it in Receipts"
				tellConsequence="They get an alert to check the provider and record what happened."
				tellLabel="Tell your team"
				title="If a provider never confirms whether a call went through…"
				value={answers.tellOnUnknown}
				variant={variant}
			/>
			{actsForTeam(answers.actingFor) ? (
				<TellQuestion
					disabled={disabled}
					onChange={(tellOnBroken) => onChange({ ...answers, tellOnBroken })}
					quietConsequence="It shows as needing a reconnect in Integrations."
					quietLabel="Stay quiet"
					tellConsequence="They get an alert to reconnect it. Calls that need it are refused until then."
					tellLabel="Tell your team"
					title="If one of your connected accounts stops working…"
					value={answers.tellOnBroken}
					variant={variant}
				/>
			) : null}
			{actsForUsers(answers.actingFor) ? (
				<Question
					title="If a user's connected account stops working…"
					variant={variant}
				>
					{() => (
						<div
							className={cn(
								variant === "bordered"
									? "overflow-hidden rounded-lg border"
									: "border-t border-border/70",
							)}
						>
							<FixedRow
								consequence={
									hasRedirect
										? "Nothing is sent, and your server gets a link to send them to reconnect."
										: "Nothing is sent. With a redirect URL set, your server also gets a link to send them to reconnect."
								}
								icon={<PlugZap />}
								label="Their next call is refused"
								variant={variant}
							/>
						</div>
					)}
				</Question>
			) : null}
			<TellQuestion
				disabled={disabled}
				hint={
					actsForUsers(answers.actingFor)
						? "A request your users decide also reaches your app as an approval.expired event."
						: undefined
				}
				onChange={(tellOnExpired) => onChange({ ...answers, tellOnExpired })}
				quietConsequence="The call is cancelled and shows as expired in Approvals."
				quietLabel="Cancel quietly"
				tellConsequence="The call is cancelled, nothing is sent, and your team gets an alert."
				tellLabel="Cancel and tell your team"
				title="If nobody answers a request in time…"
				value={answers.tellOnExpired}
				variant={variant}
			/>
		</>
	);
}

const ALWAYS_ON: { icon: ReactNode; label: string; detail: string }[] = [
	{
		icon: <ShieldCheck />,
		label: "Your agent can't approve its own request",
		detail: "A key can never decide a request it made.",
	},
	{
		icon: <KeyRound />,
		label: "Your agent can't raise its own limits",
		detail:
			"Changing a limit needs a permission keys don't get unless you grant it.",
	},
	{
		icon: <EyeOff />,
		label: "Keys never reach the model",
		detail:
			"Account keys and tokens are used when a call runs and are never returned.",
	},
	{
		icon: <ReceiptText />,
		label: "Every call gets a receipt",
		detail: "Each call Anlyon accepts is recorded with what it did.",
	},
];

export function AlwaysOnList({
	className,
	variant = "bordered",
}: {
	className?: string;
	variant?: ChoiceListVariant;
}) {
	return (
		<ul
			className={cn(
				"grid gap-x-6 gap-y-3 sm:grid-cols-2",
				variant === "flush" && "p-5",
				className,
			)}
		>
			{ALWAYS_ON.map((item) => (
				<li className="flex min-w-0 items-start gap-2.5" key={item.label}>
					<span
						aria-hidden="true"
						className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-success [&_svg]:size-4"
					>
						{item.icon}
					</span>
					<span className="flex min-w-0 flex-col gap-0.5">
						<span className="text-[13px] leading-5">{item.label}</span>
						<span className="text-pretty text-[12px] text-muted-foreground leading-[1.1rem]">
							{item.detail}
						</span>
					</span>
				</li>
			))}
		</ul>
	);
}
