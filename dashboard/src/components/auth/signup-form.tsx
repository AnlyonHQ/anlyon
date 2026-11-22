import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { AuthorizeRequestNotice } from "@/components/auth/authorize-request-notice";
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

const passwordSchema = z
	.string()
	.min(8, "Password must be at least 8 characters")
	.regex(/[A-Z]/, "Password must contain at least one uppercase letter")
	.regex(/[a-z]/, "Password must contain at least one lowercase letter")
	.regex(/[0-9]/, "Password must contain at least one number")
	.regex(
		/[^A-Za-z0-9]/,
		"Password must contain at least one special character",
	);

const signupSchema = z
	.object({
		name: z.string().min(2, "Name must be at least 2 characters"),
		email: z.string().email("Invalid email address"),
		password: passwordSchema,
		confirmPassword: z.string(),
	})
	.refine((data) => data.password === data.confirmPassword, {
		message: "Passwords don't match",
		path: ["confirmPassword"],
	});

type SignupFormData = z.infer<typeof signupSchema>;

interface SignupFormProps extends React.ComponentProps<"div"> {
	defaultEmail?: string;
	redirectTo?: string;
}

export function SignupForm({
	className,
	defaultEmail,
	redirectTo,
	...props
}: SignupFormProps) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [isLoading, setIsLoading] = useState(false);
	const [oauthLoading, setOauthLoading] = useState<string | null>(null);
	const { request: authorizeRequest, firstParty } = useAuthorizeRequest();
	const liveRequest =
		authorizeRequest && !authorizeRequest.expired ? authorizeRequest : null;
	const [checkEmailFor, setCheckEmailFor] = useState<string | null>(null);

	const returnTo = safeReturnPath(redirectTo);
	const getRedirectUrl = () => returnTo ?? "/get-started";

	const {
		register,
		handleSubmit,
		formState: { errors },
	} = useForm<SignupFormData>({
		resolver: zodResolver(signupSchema),
		defaultValues: {
			email: defaultEmail || "",
		},
	});

	const onSubmit = async (data: SignupFormData) => {
		const rateLimitKey = `signup_${data.email}`;
		if (
			isRateLimited({
				maxAttempts: 3,
				windowMs: 60 * 60 * 1000,
				key: rateLimitKey,
			})
		) {
			const resetTime = getRateLimitResetTime(rateLimitKey);
			toastManager.add({
				title: "Too many signup attempts",
				type: "error",
				description: `Please wait ${Math.ceil(resetTime / 60)} minutes before trying again.`,
			});
			return;
		}

		try {
			setIsLoading(true);
			const result = await authClient.signUp.email({
				email: data.email,
				password: data.password,
				name: data.name,
				...(liveRequest
					? { callbackURL: `/auth/login?${liveRequest.query}` }
					: returnTo
						? { callbackURL: returnTo }
						: {}),
			});
			if (result.error) {
				toastManager.add({
					title: result.error.message || "Signup failed.",
					type: "error",
				});
				return;
			}
			if ((liveRequest || returnTo) && !result.data?.token) {
				setCheckEmailFor(data.email);
				return;
			}
			await queryClient.invalidateQueries({ queryKey: ["auth"] });
			toastManager.add({
				title: "Account created successfully!",
				type: "success",
				description: returnTo ? "Taking you back..." : undefined,
			});
			navigate({ href: getRedirectUrl() });
		} catch (error) {
			secureLogger.error("Signup error:", error);
			toastManager.add({
				title: "Signup failed. Please check your information and try again.",
				type: "error",
			});
		} finally {
			setIsLoading(false);
		}
	};

	const handleOAuthSignup = async (provider: "apple" | "google" | "github") => {
		try {
			setOauthLoading(provider);
			const redirectPath = getRedirectUrl();
			const callbackURL = `${window.location.origin}${redirectPath}`;
			await authClient.signIn.social({
				provider,
				callbackURL: callbackURL,
			});
		} catch (error) {
			secureLogger.error(`${provider} signup error:`, error);
			toastManager.add({
				title: `${provider} signup failed`,
				type: "error",
			});
			setOauthLoading(null);
		}
	};

	if (checkEmailFor) {
		return (
			<div
				className={cn("flex flex-col gap-2 text-center", className)}
				{...props}
			>
				<h1 className="text-2xl font-semibold tracking-tight">
					Check your email
				</h1>
				<p className="text-sm text-muted-foreground">
					We sent a link to {checkEmailFor}.{" "}
					{firstParty
						? `It brings you back to ${firstParty.displayName}.`
						: "It brings you back here to finish signing in."}
				</p>
			</div>
		);
	}

	return (
		<div className={cn("flex flex-col gap-6", className)} {...props}>
			<div className="flex flex-col gap-2 text-center">
				<h1 className="text-2xl font-semibold tracking-tight">
					Create an account
				</h1>
				<AuthorizeRequestNotice
					request={authorizeRequest}
					firstParty={firstParty}
				/>
			</div>

			<Form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
				<div className="flex flex-col sm:flex-col gap-2">
					<Button
						variant="outline"
						type="button"
						disabled={oauthLoading !== null}
						onClick={() => handleOAuthSignup("github")}
						loading={oauthLoading === "github"}
					>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							viewBox="0 0 24 24"
							fill="currentColor"
						>
							<path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
						</svg>
						<span>Sign up with GitHub</span>
					</Button>
					<Button
						variant="outline"
						type="button"
						disabled={oauthLoading !== null}
						onClick={() => handleOAuthSignup("google")}
						loading={oauthLoading === "google"}
					>
						<img src="/google.svg" alt="Google" className="w-4 h-4" />
						<span>Sign up with Google</span>
					</Button>
				</div>
				<div className="relative flex items-center gap-3 py-2">
					<Separator className="flex-1" />
					<span className="text-xs text-muted-foreground">OR</span>
					<Separator className="flex-1" />
				</div>
				<Field name="name">
					<FieldLabel htmlFor="name">Name</FieldLabel>
					<Input
						id="name"
						type="text"
						placeholder="Enter your name"
						{...register("name")}
						disabled={isLoading}
					/>
					{errors.name && <FieldError>{errors.name.message}</FieldError>}
				</Field>

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
					<FieldLabel htmlFor="password">Password</FieldLabel>
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

				<Field name="confirmPassword">
					<FieldLabel htmlFor="confirmPassword">Confirm Password</FieldLabel>
					<Input
						id="confirmPassword"
						type="password"
						placeholder="••••••••"
						{...register("confirmPassword")}
						disabled={isLoading}
					/>
					{errors.confirmPassword && (
						<FieldError>{errors.confirmPassword.message}</FieldError>
					)}
				</Field>

				<Button
					type="submit"
					disabled={isLoading}
					loading={isLoading}
					className="w-full"
				>
					Get started
				</Button>
			</Form>

			<p className="text-center text-sm text-muted-foreground">
				Already have an account?{" "}
				<a
					href={withAuthorizeRequest(
						"/auth/login",
						authorizeRequest,
						returnTo ?? undefined,
					)}
					className="font-medium text-primary hover:underline"
				>
					Log in
				</a>
			</p>
		</div>
	);
}
