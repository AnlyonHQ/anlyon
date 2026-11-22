const SENSITIVE_FIELDS = [
	"password",
	"token",
	"secret",
	"key",
	"apiKey",
	"api_key",
	"authorization",
	"auth",
	"credential",
	"session",
	"cookie",
	"csrf",
	"accessToken",
	"refreshToken",
	"signature",
] as const;

const SENSITIVE_PATTERNS = [
	/password/i,
	/token/i,
	/secret/i,
	/key/i,
	/auth/i,
	/credential/i,
	/session/i,
	/cookie/i,
	/csrf/i,
	/bearer\s+[\w-]+/i,
] as const;

function redactSensitiveData<T>(obj: T): T {
	if (obj === null || obj === undefined) {
		return obj;
	}

	if (typeof obj !== "object") {
		if (typeof obj === "string") {
			for (const pattern of SENSITIVE_PATTERNS) {
				if (pattern.test(obj)) {
					return "[REDACTED]" as T;
				}
			}
		}
		return obj;
	}

	if (Array.isArray(obj)) {
		return obj.map(redactSensitiveData) as T;
	}

	const redacted = { ...obj } as Record<string, unknown>;

	for (const key in redacted) {
		const lowerKey = key.toLowerCase();

		if (SENSITIVE_FIELDS.some((field) => lowerKey.includes(field))) {
			redacted[key] = "[REDACTED]";
			continue;
		}

		redacted[key] = redactSensitiveData(redacted[key]);
	}

	return redacted as T;
}

export const secureLogger = {
	log: (...args: unknown[]) => {
		if (import.meta.env.DEV) {
			const redacted = args.map(redactSensitiveData);
			console.log(...redacted);
		}
	},

	error: (message: string, error?: unknown) => {
		const redactedError = error ? redactSensitiveData(error) : error;
		console.error(message, redactedError);
	},

	warn: (...args: unknown[]) => {
		if (import.meta.env.DEV) {
			const redacted = args.map(redactSensitiveData);
			console.warn(...redacted);
		}
	},

	debug: (...args: unknown[]) => {
		if (import.meta.env.DEV) {
			const redacted = args.map(redactSensitiveData);
			console.debug(...redacted);
		}
	},
};
