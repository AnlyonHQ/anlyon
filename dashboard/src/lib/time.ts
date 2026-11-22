const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatRelative(
	value: string | number | Date,
	now: number = Date.now(),
): string {
	const time = new Date(value).getTime();
	if (Number.isNaN(time)) return "";
	const diff = now - time;
	const future = diff < 0;
	const span = Math.abs(diff);
	const say = (text: string) => (future ? `in ${text}` : `${text} ago`);

	if (span < 45_000) return future ? "in a moment" : "just now";
	if (span < HOUR) return say(`${Math.max(1, Math.round(span / MINUTE))} min`);
	if (span < DAY) return say(`${Math.round(span / HOUR)} hr`);
	if (!future && span < 2 * DAY) return "yesterday";
	if (span < 30 * DAY) return say(`${Math.round(span / DAY)} days`);
	return formatDate(time, now);
}

export function formatDate(
	value: string | number | Date,
	now: number = Date.now(),
): string {
	const date = new Date(value);
	const sameYear = date.getFullYear() === new Date(now).getFullYear();
	return date.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		...(sameYear ? {} : { year: "numeric" }),
	});
}

export function formatExact(value: string | number | Date): string {
	return new Date(value).toLocaleString(undefined, {
		weekday: "short",
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		second: "2-digit",
	});
}
