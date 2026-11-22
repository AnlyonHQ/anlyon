const STORAGE_PREFIX = "anlyon_";

export const secureStorage = {
	getItem: (key: string): string | null => {
		try {
			return localStorage.getItem(`${STORAGE_PREFIX}${key}`);
		} catch (error) {
			console.error("Storage get error:", error);
			return null;
		}
	},

	setItem: (key: string, value: string): void => {
		try {
			localStorage.setItem(`${STORAGE_PREFIX}${key}`, value);
		} catch (error) {
			console.error("Storage set error:", error);
		}
	},

	removeItem: (key: string): void => {
		try {
			localStorage.removeItem(`${STORAGE_PREFIX}${key}`);
		} catch (error) {
			console.error("Storage remove error:", error);
		}
	},

	clear: (): void => {
		try {
			const keys = Object.keys(localStorage);
			keys.forEach((key) => {
				if (key.startsWith(STORAGE_PREFIX)) {
					localStorage.removeItem(key);
				}
			});
		} catch (error) {
			console.error("Storage clear error:", error);
		}
	},
};

export const secureSessionStorage = {
	getItem: (key: string): string | null => {
		try {
			return sessionStorage.getItem(`${STORAGE_PREFIX}${key}`);
		} catch (error) {
			console.error("Session storage get error:", error);
			return null;
		}
	},

	setItem: (key: string, value: string): void => {
		try {
			sessionStorage.setItem(`${STORAGE_PREFIX}${key}`, value);
		} catch (error) {
			console.error("Session storage set error:", error);
		}
	},

	removeItem: (key: string): void => {
		try {
			sessionStorage.removeItem(`${STORAGE_PREFIX}${key}`);
		} catch (error) {
			console.error("Session storage remove error:", error);
		}
	},

	clear: (): void => {
		try {
			const keys = Object.keys(sessionStorage);
			keys.forEach((key) => {
				if (key.startsWith(STORAGE_PREFIX)) {
					sessionStorage.removeItem(key);
				}
			});
		} catch (error) {
			console.error("Session storage clear error:", error);
		}
	},
};
