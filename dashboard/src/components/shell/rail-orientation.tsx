import {
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import type { AreaId } from "./nav-config";

export interface OrientationNote {
	area: AreaId;
	title: string;
	body: string;
}

export const ORIENTATION_NOTES: OrientationNote[] = [
	{
		area: "build",
		title: "Agents & actions",
		body: "What your agent can do: the actions it calls, and the code that calls them.",
	},
	{
		area: "integrations",
		title: "Integrations",
		body: "The apps your agent acts in: your own account, each of your users' accounts, and how they sign in.",
	},
	{
		area: "users",
		title: "Users",
		body: "The people using your product. Each connects their own accounts, and your agent acts in them.",
	},
	{
		area: "controls",
		title: "Controls",
		body: "The rules your agent runs under, for your workspace and for each user: policies, limits, and the approvals they hold.",
	},
	{
		area: "activity",
		title: "Activity",
		body: "What happened: every call your agent made, with its receipt.",
	},
];

const seenKey = (who: string) => `anlyon.orientation.seen.${who}`;

export function readOrientationSeen(who: string | undefined): boolean {
	if (!who) return true;
	try {
		return window.localStorage.getItem(seenKey(who)) === "1";
	} catch {
		return true;
	}
}

export function writeOrientationSeen(who: string): void {
	try {
		window.localStorage.setItem(seenKey(who), "1");
	} catch {
	}
}

export const ORIENTATION_DELAY_MS = 800;

const railItem = (area: AreaId) =>
	document.querySelector<HTMLElement>(
		`[data-slot="nav-rail"] [data-area="${area}"]`,
	);

export function RailOrientation() {
	const { user } = useAuth();
	const who = user?.id ?? user?.email ?? undefined;
	const [step, setStep] = useState<number | null>(null);
	const [notes, setNotes] = useState<OrientationNote[]>([]);
	const [rect, setRect] = useState<DOMRect | null>(null);
	const titleId = useId();
	const bodyId = useId();

	useEffect(() => {
		if (readOrientationSeen(who)) return;
		const timer = window.setTimeout(() => {
			const present = ORIENTATION_NOTES.filter((note) => railItem(note.area));
			if (present.length === 0) return;
			setNotes(present);
			setStep(0);
		}, ORIENTATION_DELAY_MS);
		return () => window.clearTimeout(timer);
	}, [who]);

	const finish = useCallback(() => {
		if (who) writeOrientationSeen(who);
		setStep(null);
	}, [who]);

	const note = step === null ? null : notes[step];

	useLayoutEffect(() => {
		if (!note) return;
		const measure = () =>
			setRect(railItem(note.area)?.getBoundingClientRect() ?? null);
		measure();
		window.addEventListener("resize", measure);
		return () => window.removeEventListener("resize", measure);
	}, [note]);

	useEffect(() => {
		if (!note) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") finish();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [note, finish]);

	if (!note || step === null) return null;
	const last = step === notes.length - 1;
	const top = rect ? rect.top + rect.height / 2 : 0;
	const left = rect ? rect.right + 12 : 68;

	return createPortal(
		<>
			{rect ? (
				<span
					aria-hidden="true"
					className="pointer-events-none fixed z-50 rounded-lg ring-2 ring-primary/70 ring-offset-2 ring-offset-sidebar transition-[top,left] duration-200 ease-out"
					data-slot="orientation-ring"
					style={{
						top: rect.top,
						left: rect.left,
						width: rect.width,
						height: rect.height,
					}}
				/>
			) : null}
			<div
				aria-describedby={bodyId}
				aria-labelledby={titleId}
				className="fixed z-50 w-[272px] -translate-y-1/2 transition-[top] duration-200 ease-out"
				data-slot="orientation"
				role="dialog"
				style={{ top, left }}
			>
				<div
					className="onboarding-enter relative rounded-lg border bg-popover p-3.5 text-popover-foreground shadow-lg"
					key={note.area}
				>
					<span
						aria-hidden="true"
						className="absolute top-1/2 -left-[5px] size-2.5 -translate-y-1/2 rotate-45 border-b border-l bg-popover"
					/>
					<div className="flex items-baseline justify-between gap-3">
						<h2 className="font-medium text-[13.5px]" id={titleId}>
							{note.title}
						</h2>
						<span className="text-[11.5px] text-muted-foreground tabular-nums">
							{step + 1} of {notes.length}
						</span>
					</div>
					<p
						className="mt-1 text-pretty text-[12.5px] text-muted-foreground leading-snug"
						id={bodyId}
					>
						{note.body}
					</p>
					<div className="mt-3 flex items-center justify-end gap-1.5">
						{last ? null : (
							<Button onClick={finish} size="xs" variant="ghost">
								Skip
							</Button>
						)}
						<Button
							onClick={() => (last ? finish() : setStep(step + 1))}
							size="xs"
						>
							{last ? "Done" : "Next"}
						</Button>
					</div>
				</div>
			</div>
		</>,
		document.body,
	);
}
