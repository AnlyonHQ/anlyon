import { zodResolver } from "@hookform/resolvers/zod";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Mail } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { toastManager } from "@/components/ui/toast";
import { authClient } from "@/lib/auth-client";
import { secureLogger } from "@/lib/logger";
import { getRateLimitResetTime, isRateLimited } from "@/lib/rate-limit";
import { cn } from "@/lib/utils";

const forgotPasswordSchema = z.object({
	email: z.string().email("Please enter a valid email address"),
});

type ForgotPasswordFormData = z.infer<typeof forgotPasswordSchema>;

interface ForgotPasswordFormProps extends React.ComponentProps<"div"> {}

export function ForgotPasswordForm({
	className,
	...props
}: ForgotPasswordFormProps) {
	const [isLoading, setIsLoading] = useState(false);
	const [isSuccess, setIsSuccess] = useState(false);
	const [submittedEmail, setSubmittedEmail] = useState("");

	const {
		register,
		handleSubmit,
		formState: { errors },
	} = useForm<ForgotPasswordFormData>({
		resolver: zodResolver(forgotPasswordSchema),
	});

	const onSubmit = async (data: ForgotPasswordFormData) => {
		const rateLimitKey = `forgot_password_${data.email}`;
		if (
			isRateLimited({
				maxAttempts: 3,
				windowMs: 15 * 60 * 1000,
				key: rateLimitKey,
			})
		) {
			const resetTime = getRateLimitResetTime(rateLimitKey);
			toastManager.add({
				title: "Too many requests",
				type: "error",
				description: `Please wait ${resetTime} seconds before trying again.`,
			});
			return;
		}

		try {
			setIsLoading(true);

			const redirectTo = `${window.location.origin}/auth/reset-password`;

			await authClient.requestPasswordReset({
				email: data.email,
				redirectTo,
			});

			setSubmittedEmail(data.email);
			setIsSuccess(true);
		} catch (error) {
			secureLogger.error("Forgot password error:", error);
			setSubmittedEmail(data.email);
			setIsSuccess(true);
		} finally {
			setIsLoading(false);
		}
	};

	if (isSuccess) {
		return (
			<div className={cn("flex flex-col gap-6", className)} {...props}>
				<div className="flex flex-col items-center gap-4 text-center">
					<div className="flex flex-col gap-2">
						<h1 className="text-2xl font-semibold tracking-tight">
							Check your email
						</h1>
						<p className="text-sm text-muted-foreground">
							If an account exists for{" "}
							<span className="font-medium text-foreground">
								{submittedEmail}
							</span>
							, we've sent a password reset link.
						</p>
					</div>
				</div>

				<div className="flex flex-col gap-3">
					<div className="rounded-lg border bg-muted/50 p-4">
						<div className="flex items-start gap-3">
							<Mail className="h-5 w-5 text-muted-foreground mt-0.5" />
							<div className="text-sm">
								<p className="font-medium">Didn't receive an email?</p>
								<ul className="mt-1 text-muted-foreground space-y-1">
									<li>Check your spam or junk folder</li>
									<li>Make sure you entered the correct email</li>
									<li>Wait a few minutes and try again</li>
								</ul>
							</div>
						</div>
					</div>

					<Button
						variant="outline"
						onClick={() => {
							setIsSuccess(false);
							setSubmittedEmail("");
						}}
					>
						Try a different email
					</Button>
				</div>

				<Link
					to="/auth/login"
					className="flex items-center justify-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
				>
					<ArrowLeft className="h-4 w-4" />
					Back to login
				</Link>
			</div>
		);
	}

	return (
		<div className={cn("flex flex-col gap-6", className)} {...props}>
			<div className="flex flex-col gap-2 text-center">
				<h1 className="text-2xl font-semibold tracking-tight">
					Forgot your password?
				</h1>
				<p className="text-sm text-muted-foreground">
					Enter your email address and we'll send you a link to reset your
					password.
				</p>
			</div>

			<Form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
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

				<Button type="submit" disabled={isLoading} className="w-full">
					{isLoading ? "Sending..." : "Send reset link"}
				</Button>
			</Form>

			<Link
				to="/auth/login"
				className="flex items-center justify-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
			>
				<ArrowLeft className="h-4 w-4" />
				Back to login
			</Link>
		</div>
	);
}
