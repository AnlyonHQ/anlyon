import { useEffect, useState } from "react";
import type { InstanceSetting } from "@/hooks/api/use-instance";
import { useServerHealth } from "@/hooks/api/use-instance";
import { systemChecks } from "@/lib/instance-onboarding";
import { cn } from "@/lib/utils";
import { StatusDot } from "./status-dot";

function useSecondsSince(time: number): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const id = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(id);
	}, []);
	return time ? Math.max(0, Math.round((now - time) / 1000)) : 0;
}

export function SystemStatus({
	settings,
	className,
}: {
	settings?: InstanceSetting[];
	className?: string;
}) {
	const health = useServerHealth();
	const checks = systemChecks(
		health.data ?? (health.isError ? { api: false } : {}),
		settings,
	);
	const seconds = useSecondsSince(health.dataUpdatedAt);
	const allUp = checks.slice(0, 3).every((check) => check.tone === "ok");

	return (
		<section
			aria-label="Server status"
			className={cn("border bg-card text-card-foreground", className)}
		>
			<div className="flex items-center justify-between gap-3 border-b px-4 py-2 text-[12px] text-muted-foreground">
				<span className="ed-label">Server</span>
				<span className="tabular-nums" aria-live="off">
					{health.dataUpdatedAt
						? seconds < 2
							? "checked just now"
							: `checked ${seconds}s ago`
						: "checking"}
				</span>
			</div>
			<ul className="grid grid-cols-2 sm:grid-cols-5">
				{checks.map((check, index) => (
					<li
						className={cn(
							"flex min-w-0 flex-col gap-1 px-3 py-2.5 sm:pr-2",
							index > 0 && "sm:border-l",
							index % 2 === 1 && "border-l sm:border-l",
							index > 1 && "border-t sm:border-t-0",
						)}
						key={check.id}
					>
						<span className="flex items-center gap-2 text-[13px] font-medium">
							<StatusDot
								pending={health.isFetching && index < 3}
								tone={check.tone}
							/>
							{check.label}
						</span>
						<span className="whitespace-nowrap pl-3.5 text-[12px] text-muted-foreground leading-4">
							{check.detail}
						</span>
					</li>
				))}
			</ul>
			<p aria-live="polite" className="sr-only">
				{health.data
					? allUp
						? "API, database and Redis are up."
						: `Not reachable: ${checks
								.slice(0, 3)
								.filter((check) => check.tone !== "ok")
								.map((check) => check.label)
								.join(", ")}.`
					: ""}
			</p>
		</section>
	);
}
