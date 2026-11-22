const HOST_PATTERN =
	/^\.?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

export const MAX_ALLOWED_HOSTS = 20;

export type AllowedHostsResult =
	| { ok: true; hosts: string[] }
	| { ok: false; error: string };

function hostProblem(host: string): string | null {
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host) || host.includes("/"))
		return `${host} is not a bare hostname. Leave out https:// and any path, as in api.stripe.com.`;
	if (host.includes("*"))
		return `${host}: start a host with a dot instead of *, as in .stripe.com, to allow its subdomains.`;
	if (host.includes(":"))
		return `${host}: leave out the port, as in api.stripe.com.`;
	if (host.length > 253 || !HOST_PATTERN.test(host))
		return `${host} is not a hostname, such as api.stripe.com.`;
	return null;
}

export function parseAllowedHosts(text: string): AllowedHostsResult {
	const hosts = [
		...new Set(
			text
				.split(/[\s,]+/)
				.map((host) => host.trim().toLowerCase())
				.filter(Boolean),
		),
	];
	if (hosts.length === 0)
		return {
			ok: false,
			error: "Name at least one host this secret may be sent to.",
		};
	if (hosts.length > MAX_ALLOWED_HOSTS)
		return {
			ok: false,
			error: `Name at most ${MAX_ALLOWED_HOSTS} hosts.`,
		};
	for (const host of hosts) {
		const problem = hostProblem(host);
		if (problem) return { ok: false, error: problem };
	}
	return { ok: true, hosts };
}
