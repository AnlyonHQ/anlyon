import {
	useCallback,
	useEffect,
	useMemo,
	useState,
	useSyncExternalStore,
} from "react";
import type { FirstRunStep } from "@/lib/first-run";

const hiddenKey = (workspaceId: string) =>
	`anlyon.first-run.hidden.${workspaceId}`;
const clockKey = (workspaceId: string) =>
	`anlyon.first-run.clock.${workspaceId}`;
const HIDDEN_EVENT = "anlyon:first-run-hidden";

function read(storage: () => Storage, key: string): string | null {
	try {
		return storage().getItem(key);
	} catch {
		return null;
	}
}

function write(
	storage: () => Storage,
	key: string,
	value: string | null,
): void {
	try {
		if (value === null) storage().removeItem(key);
		else storage().setItem(key, value);
	} catch {
	}
}

const local = () => window.localStorage;
const session = () => window.sessionStorage;

function subscribeHidden(callback: () => void): () => void {
	window.addEventListener(HIDDEN_EVENT, callback);
	window.addEventListener("storage", callback);
	return () => {
		window.removeEventListener(HIDDEN_EVENT, callback);
		window.removeEventListener("storage", callback);
	};
}

export function useFirstRunHidden(
	workspaceId?: string,
): [boolean, (hidden: boolean) => void] {
	const hidden = useSyncExternalStore(
		subscribeHidden,
		() => (workspaceId ? read(local, hiddenKey(workspaceId)) === "1" : false),
		() => false,
	);
	const setHidden = useCallback(
		(next: boolean) => {
			if (!workspaceId) return;
			write(local, hiddenKey(workspaceId), next ? "1" : null);
			window.dispatchEvent(new Event(HIDDEN_EVENT));
		},
		[workspaceId],
	);
	return [hidden, setHidden];
}

interface ClockRecord {
	startedAt: number;
	finishedAt: number | null;
}

function readClock(workspaceId: string): ClockRecord | null {
	const raw = read(session, clockKey(workspaceId));
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as ClockRecord;
		return typeof parsed.startedAt === "number" ? parsed : null;
	} catch {
		return null;
	}
}

export function useFirstRunClock(
	workspaceId: string | undefined,
	step: FirstRunStep,
) {
	const [record, setRecord] = useState<ClockRecord | null>(() =>
		workspaceId ? readClock(workspaceId) : null,
	);
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		if (!workspaceId) return;
		const stored = readClock(workspaceId);
		if (step === "done") {
			if (stored && stored.finishedAt === null) {
				const finished = { ...stored, finishedAt: Date.now() };
				write(session, clockKey(workspaceId), JSON.stringify(finished));
				setRecord(finished);
			} else {
				setRecord(stored);
			}
			return;
		}
		if (!stored || stored.finishedAt !== null) {
			const started = { startedAt: Date.now(), finishedAt: null };
			write(session, clockKey(workspaceId), JSON.stringify(started));
			setRecord(started);
		} else {
			setRecord(stored);
		}
	}, [workspaceId, step]);

	const running = record !== null && record.finishedAt === null;
	useEffect(() => {
		if (!running) return;
		const id = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(id);
	}, [running]);

	const reset = useCallback(() => {
		if (workspaceId) write(session, clockKey(workspaceId), null);
		setRecord(null);
	}, [workspaceId]);

	const elapsedMs = record
		? (record.finishedAt ?? now) - record.startedAt
		: null;
	return { elapsedMs, reset };
}

const quickstartKey = (workspaceId: string) =>
	`anlyon.quickstart.${workspaceId}`;
const QUICKSTART_EVENT = "anlyon:quickstart";

export interface QuickstartChoice {
	integration: string;
	startedAt: string;
	finishedAt: string | null;
}

function readQuickstart(workspaceId: string): QuickstartChoice | null {
	const raw = read(local, quickstartKey(workspaceId));
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as QuickstartChoice;
		return typeof parsed.integration === "string" &&
			typeof parsed.startedAt === "string"
			? { ...parsed, finishedAt: parsed.finishedAt ?? null }
			: null;
	} catch {
		return null;
	}
}

function subscribeQuickstart(callback: () => void): () => void {
	window.addEventListener(QUICKSTART_EVENT, callback);
	window.addEventListener("storage", callback);
	return () => {
		window.removeEventListener(QUICKSTART_EVENT, callback);
		window.removeEventListener("storage", callback);
	};
}

export function useQuickstartChoice(
	workspaceId?: string,
): [QuickstartChoice | null, (next: QuickstartChoice | null) => void] {
	const [fallback, setFallback] = useState<QuickstartChoice | null>(null);
	const raw = useSyncExternalStore(
		subscribeQuickstart,
		() => (workspaceId ? read(local, quickstartKey(workspaceId)) : null),
		() => null,
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-read when the stored string changes
	const stored = useMemo(
		() => (workspaceId ? readQuickstart(workspaceId) : null),
		[workspaceId, raw],
	);
	const set = useCallback(
		(next: QuickstartChoice | null) => {
			setFallback(next);
			if (!workspaceId) return;
			write(
				local,
				quickstartKey(workspaceId),
				next ? JSON.stringify(next) : null,
			);
			window.dispatchEvent(new Event(QUICKSTART_EVENT));
		},
		[workspaceId],
	);
	return [stored ?? fallback, set];
}

export function useElapsed(
	startedAt: string | null,
	finishedAt: string | null,
): number | null {
	const [now, setNow] = useState(() => Date.now());
	const running = startedAt !== null && finishedAt === null;
	useEffect(() => {
		if (!running) return;
		const id = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(id);
	}, [running]);
	if (!startedAt) return null;
	const end = finishedAt ? Date.parse(finishedAt) : now;
	return Math.max(0, end - Date.parse(startedAt));
}
