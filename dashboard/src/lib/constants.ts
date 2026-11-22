import { runtimeConfig } from "./runtime-config";

export const API_BASE_URL =
	typeof runtimeConfig.apiBaseUrl === "string"
		? runtimeConfig.apiBaseUrl.replace(/\/$/, "") || window.location.origin
		: import.meta.env.VITE_API_BASE_URL ||
			(import.meta.env.DEV
				? "http://localhost:4000"
				: "https://api.anlyon.com");
