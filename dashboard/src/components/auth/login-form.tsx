import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { AuthorizeRequestNotice } from "@/components/auth/authorize-request-notice";
import { SsoSignInForm } from "@/components/auth/sso-sign-in";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { toastManager } from "@/components/ui/toast";
import { authClient } from "@/lib/auth-client";
import { secureLogger } from "@/lib/logger";
import { useAuthorizeRequest, withAuthorizeRequest } from "@/lib/oauth-return";
import { getRateLimitResetTime, isRateLimited } from "@/lib/rate-limit";
import { safeReturnPath } from "@/lib/security";
import { cn } from "@/lib/utils";

const loginSchema = z.object({
	email: z.string().email("Invalid email address"),
	password: z.string().min(8, "Password must be at least 8 characters"),
});

type LoginFormData = z.infer<typeof loginSchema>;

interface LoginFormProps extends React.ComponentProps<"div"> {
	redirectTo?: string;
	sso?: "required" | "failed";
}

const SSO_NOTICES = {
	required:
		"Your workspace requires single sign-on. Continue with your work email.",
	failed:
		"Single sign-on did not complete. Try again, or ask your workspace admin to check the identity provider.",
} as const;

const twoFactorRedirectStorageKey = "anlyon.auth.redirect-after-two-factor";

export function LoginForm({
	className,
	redirectTo,
	sso,
	...props
}: LoginFormProps) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [isLoading, setIsLoading] = useState(false);
	const [oauthLoading, setOauthLoading] = useState<string | null>(null);
	const [ssoMode, setSsoMode] = useState(Boolean(sso));
	const [ssoNotice, setSsoNotice] = useState<string | undefined>(
		sso ? SSO_NOTICES[sso] : undefined,
	);
	const [ssoEmail, setSsoEmail] = useState("");
	const { request: authorizeRequest, firstParty } = useAuthorizeRequest();

	const getRedirectUrl = () => safeReturnPath(redirectTo) ?? "/dashboard";

	const {
		register,
		handleSubmit,
		formState: { errors },
	} = useForm<LoginFormData>({
		resolver: zodResolver(loginSchema),
	});

	const onSubmit = async (data: LoginFormData) => {
		const rateLimitKey = `login_${data.email}`;
		if (
			isRateLimited({
				maxAttempts: 5,
				windowMs: 15 * 60 * 1000,
				key: rateLimitKey,
			})
		) {
			const resetTime = getRateLimitResetTime(rateLimitKey);
			toastManager.add({
				title: "Too many login attempts",
				type: "error",
				description: `Please wait ${resetTime} seconds before trying again.`,
			});
			return;
		}

		try {
			setIsLoading(true);
			try {
				sessionStorage.setItem(twoFactorRedirectStorageKey, getRedirectUrl());
			} catch {
			}
			const result: any = await authClient.signIn.email({
				email: data.email,
				password: data.password,
			});
			if (result.error?.code === "SSO_REQUIRED") {
				setSsoEmail(data.email);
				setSsoNotice(SSO_NOTICES.required);
				setSsoMode(true);
				return;
			}
			if (
				result.error?.code === "EMAIL_NOT_VERIFIED" ||
				result.error?.status === 500 ||
				result.error?.code === "INVALID_EMAIL_OR_PASSWORD"
			) {
				toastManager.add({
					title: result.error?.message,
					type: "error",
				});
				return;
			} else if (result.data?.twoFactorRedirect) {
				return;
			} else {
				await queryClient.invalidateQueries({ queryKey: ["auth"] });
				toastManager.add({
					title: "Login successful!",
					type: "success",
					description: redirectTo ? "Redirecting..." : undefined,
				});
				navigate({ href: getRedirectUrl() });
			}
		} catch (error) {
			secureLogger.error("Login error:", error);
			toastManager.add({
				title: "Login failed. Please check your credentials and try again.",
				type: "error",
			});
		} finally {
			setIsLoading(false);
		}
	};

	const handleOAuthLogin = async (provider: "apple" | "google" | "github") => {
		try {
			setOauthLoading(provider);
			const redirectPath = getRedirectUrl();
			const callbackURL = `${window.location.origin}${redirectPath}`;
			await authClient.signIn.social({
				provider,
				callbackURL: callbackURL,
			});
		} catch (error) {
			secureLogger.error(`${provider} login error:`, error);
			toastManager.add({
				title: `${provider} login failed`,
				type: "error",
			});
			setOauthLoading(null);
		}
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: One Tap must initialize exactly once on mount; getRedirectUrl/navigate are read at fire time.
	useEffect(() => {
		const initOneTap = async () => {
			if (!import.meta.env.VITE_GOOGLE_CLIENT_ID) {
				return;
			}

			try {
				const redirectUrl = getRedirectUrl();
				await authClient.oneTap({
					fetchOptions: {
						onSuccess: () => {
							toastManager.add({
								title: "Login successful!",
								type: "success",
							});
							navigate({ href: redirectUrl });
						},
					},
					onPromptNotification: (notification: unknown) => {
						secureLogger.debug("One Tap prompt notification:", notification);
					},
				});
			} catch (error) {
				secureLogger.debug("One Tap initialization error:", error);
			}
		};

		initOneTap();
	}, []);

	if (ssoMode) {
		return (
			<div className={cn("flex flex-col gap-6", className)} {...props}>
				<div className="flex flex-col gap-2 text-center">
					<h1 className="text-2xl font-semibold tracking-tight">
						Sign in with SSO
					</h1>
				</div>
				<SsoSignInForm
					defaultEmail={ssoEmail}
					redirectPath={getRedirectUrl()}
					notice={ssoNotice}
					onBack={() => {
						setSsoMode(false);
						setSsoNotice(undefined);
					}}
				/>
			</div>
		);
	}

	return (
		<div className={cn("flex flex-col gap-6", className)} {...props}>
			<div className="flex flex-col gap-2 text-center">
				<h1 className="text-2xl font-semibold tracking-tight">
					Log in to your account
				</h1>
				<AuthorizeRequestNotice
					request={authorizeRequest}
					firstParty={firstParty}
				/>
			</div>

			<Form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
				<div className="flex flex-col sm:flex-col gap-2  max-w-full">
					<Button
						variant="outline"
						type="button"
						disabled={oauthLoading !== null}
						onClick={() => handleOAuthLogin("github")}
						className=""
						loading={oauthLoading === "github"}
					>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							viewBox="0 0 24 24"
							fill="currentColor"
						>
							<path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
						</svg>
						<span>Sign in with GitHub</span>
					</Button>
					<Button
						variant="outline"
						type="button"
						disabled={oauthLoading !== null}
						onClick={() => handleOAuthLogin("google")}
						loading={oauthLoading === "google"}
					>
						<img src="/google.svg" alt="Google" className="w-4 h-4 " />
						<span>Sign in with Google</span>
					</Button>
					<Button
						variant="outline"
						type="button"
						disabled={oauthLoading !== null}
						onClick={() => setSsoMode(true)}
					>
						<span>Sign in with SSO</span>
					</Button>
				</div>
				<div className="relative flex items-center gap-3 py-2">
					<Separator className="flex-1" />
					<span className="text-xs text-muted-foreground">OR</span>
					<Separator className="flex-1" />
				</div>
				<Field name="email">
					<FieldLabel htmlFor="email">Email</FieldLabel>
					<Input
						id="email"
						type="email"
						placeholder="Enter your email"
						{...register("email")}
						disabled={isLoading}
					/>
					{errors.email && <FieldError>{errors.email.message}</FieldError>}
				</Field>

				<Field name="password">
					<div className="flex items-center justify-between w-full">
						<div>
							<FieldLabel htmlFor="password">Password</FieldLabel>
						</div>
						<a
							href="/auth/forgot-password"
							className="text-sm tracking-wide text-muted-foreground hover:text-primary transition-colors"
						>
							Forgot password?
						</a>
					</div>
					<Input
						id="password"
						type="password"
						placeholder="••••••••"
						{...register("password")}
						disabled={isLoading}
					/>
					{errors.password && (
						<FieldError>{errors.password.message}</FieldError>
					)}
				</Field>

				<Button
					type="submit"
					disabled={isLoading}
					loading={isLoading}
					className="w-full"
				>
					Sign in
				</Button>

			</Form>

			<p className="text-center text-sm text-muted-foreground">
				Don&apos;t have an account?{" "}
				<a
					href={withAuthorizeRequest(
						"/auth/signup",
						authorizeRequest,
						safeReturnPath(redirectTo) ?? undefined,
					)}
					className="font-medium text-primary hover:underline"
				>
					Sign up
				</a>
			</p>
		</div>
	);
}
