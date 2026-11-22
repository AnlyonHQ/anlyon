import { API_BASE_URL as BASE_URL } from "./constants";
import { redirectToSsoSignIn } from "./sso";

const API_BASE_URL = `${BASE_URL}/api/v2`;
const OAUTH_API_BASE_URL = `${BASE_URL}/api/oauth`;

export class ApiError extends Error {
	constructor(
		message: string,
		public status: number,
		public code?: string,
		public workspaceId?: string,
		public details?: unknown,
	) {
		super(message);
		this.name = "ApiError";
	}
}

interface ApiResponse<T> {
	success: boolean;
	data?: T;
	error?: {
		code: string;
		message: string;
		details?: unknown;
	};
	pagination?: {
		page: number;
		limit: number;
		total: number;
		pages: number;
	};
}

interface RequestOptions extends RequestInit {
	useApiKey?: boolean;
	apiKey?: string;
	workspaceId?: string;
	params?: Record<string, string | number | boolean | undefined>;
}

class ApiClient {
	private baseURL: string;

	constructor(baseURL: string) {
		this.baseURL = baseURL;
	}

	private buildUrl(
		endpoint: string,
		params?: Record<string, string | number | boolean | undefined>,
	): string {
		const url = new URL(`${this.baseURL}${endpoint}`);
		if (params) {
			Object.entries(params).forEach(([key, value]) => {
				if (value !== undefined && value !== null && value !== "") {
					url.searchParams.append(key, String(value));
				}
			});
		}
		return url.toString();
	}

	private async getHeaders(options?: RequestOptions): Promise<HeadersInit> {
		const headers: HeadersInit = {
			"Content-Type": "application/json",
			"X-Request-Referer": "dashboard",
		};

		if (options?.useApiKey && options?.apiKey) {
			headers.Authorization = `Bearer ${options.apiKey}`;
		} else {
		}

		if (options?.workspaceId?.trim()) {
			headers["X-Workspace-Id"] = options.workspaceId;
		}

		return headers;
	}

	private async handleResponse<T>(
		response: Response,
		workspaceId?: string,
	): Promise<T> {
		if (!response.ok) {
			try {
				const errorData: ApiResponse<never> = await response.json();
				if (errorData.error?.code === "SSO_REQUIRED") redirectToSsoSignIn();
				throw new ApiError(
					errorData.error?.message || "Request failed",
					response.status,
					errorData.error?.code,
					workspaceId,
					errorData.error?.details,
				);
			} catch (e) {
				if (e instanceof ApiError) throw e;
				throw new ApiError(
					`Request failed with status ${response.status}`,
					response.status,
				);
			}
		}

		const json: ApiResponse<T> = await response.json();

		if (!json.success) {
			throw new ApiError(
				json.error?.message || "Request failed",
				response.status,
				json.error?.code,
				workspaceId,
			);
		}

		if (json.pagination) {
			return { data: json.data, pagination: json.pagination } as T;
		}

		return json.data as T;
	}

	async get<T>(endpoint: string, options?: RequestOptions): Promise<T> {
		const headers = await this.getHeaders(options);
		const url = this.buildUrl(endpoint, options?.params);
		const restOptions = { ...options };
		delete restOptions.params;
		const response = await fetch(url, {
			method: "GET",
			headers,
			credentials: "include",
			...restOptions,
		});

		return this.handleResponse<T>(response, options?.workspaceId);
	}

	async post<T, D = unknown>(
		endpoint: string,
		data?: D,
		options?: RequestOptions,
	): Promise<T> {
		const headers = await this.getHeaders(options);
		const response = await fetch(`${this.baseURL}${endpoint}`, {
			method: "POST",
			headers,
			credentials: "include",
			body: data ? JSON.stringify(data) : undefined,
			...options,
		});

		return this.handleResponse<T>(response, options?.workspaceId);
	}

	async patch<T, D = unknown>(
		endpoint: string,
		data: D,
		options?: RequestOptions,
	): Promise<T> {
		const headers = await this.getHeaders(options);
		const response = await fetch(`${this.baseURL}${endpoint}`, {
			method: "PATCH",
			headers,
			credentials: "include",
			body: JSON.stringify(data),
			...options,
		});

		return this.handleResponse<T>(response, options?.workspaceId);
	}

	async put<T, D = unknown>(
		endpoint: string,
		data: D,
		options?: RequestOptions,
	): Promise<T> {
		const headers = await this.getHeaders(options);
		const response = await fetch(`${this.baseURL}${endpoint}`, {
			method: "PUT",
			headers,
			credentials: "include",
			body: JSON.stringify(data),
			...options,
		});

		return this.handleResponse<T>(response, options?.workspaceId);
	}

	async delete<T>(endpoint: string, options?: RequestOptions): Promise<T> {
		const headers = await this.getHeaders(options);
		const response = await fetch(`${this.baseURL}${endpoint}`, {
			method: "DELETE",
			headers,
			credentials: "include",
			...options,
		});

		return this.handleResponse<T>(response, options?.workspaceId);
	}
}

export const apiClient = new ApiClient(API_BASE_URL);
export const oauthApiClient = new ApiClient(OAUTH_API_BASE_URL);

export const healthApi = {
	check: () =>
		fetch(`${API_BASE_URL.replace("/api/v2", "")}/health`).then((r) =>
			r.json(),
		),
};
