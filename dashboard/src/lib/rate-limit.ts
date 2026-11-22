interface RateLimitOptions {
	maxAttempts: number;
	windowMs: number;
	key: string;
}

interface RateLimitState {
	attempts: number;
	resetTime: number;
}

const RATE_LIMIT_STORAGE_PREFIX = "rate_limit_";

export function isRateLimited(options: RateLimitOptions): boolean {
	const storageKey = `${RATE_LIMIT_STORAGE_PREFIX}${options.key}`;

	try {
		const stored = sessionStorage.getItem(storageKey);
		const now = Date.now();

		if (!stored) {
			const state: RateLimitState = {
				attempts: 1,
				resetTime: now + options.windowMs,
			};
			sessionStorage.setItem(storageKey, JSON.stringify(state));
			return false;
		}

		const state: RateLimitState = JSON.parse(stored);

		if (now > state.resetTime) {
			const newState: RateLimitState = {
				attempts: 1,
				resetTime: now + options.windowMs,
			};
			sessionStorage.setItem(storageKey, JSON.stringify(newState));
			return false;
		}

		if (state.attempts >= options.maxAttempts) {
			return true;
		}

		state.attempts++;
		sessionStorage.setItem(storageKey, JSON.stringify(state));
		return false;
	} catch (error) {
		console.error("Rate limit check failed:", error);
		return false;
	}
}

export function getRateLimitResetTime(key: string): number {
	const storageKey = `${RATE_LIMIT_STORAGE_PREFIX}${key}`;

	try {
		const stored = sessionStorage.getItem(storageKey);
		if (!stored) return 0;

		const state: RateLimitState = JSON.parse(stored);
		const now = Date.now();
		const remaining = Math.max(0, state.resetTime - now);
		return Math.ceil(remaining / 1000);
	} catch {
		return 0;
	}
}

export function clearRateLimit(key: string): void {
	const storageKey = `${RATE_LIMIT_STORAGE_PREFIX}${key}`;
	sessionStorage.removeItem(storageKey);
}
