import { zodResolver } from "@hookform/resolvers/zod";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, CheckCircle, XCircle } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
	Field,
	FieldDescription,
	FieldError,
	FieldLabel,
} from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { toastManager } from "@/components/ui/toast";
import { authClient } from "@/lib/auth-client";
import { secureLogger } from "@/lib/logger";
import { cn } from "@/lib/utils";
import { EyeIcon } from "../icons/eye-icon";
import { EyeOffIcon } from "../icons/eye-off-icon";

const resetPasswordSchema = z
	.object({
		password: z
			.string()
			.min(8, "Password must be at least 8 characters")
			.regex(/[A-Z]/, "Password must contain at least one uppercase letter")
			.regex(/[a-z]/, "Password must contain at least one lowercase letter")
			.regex(/[0-9]/, "Password must contain at least one number")
			.regex(
				/[^A-Za-z0-9]/,
				"Password must contain at least one special character",
			),
		confirmPassword: z.string(),
	})
	.refine((data) => data.password === data.confirmPassword, {
		message: "Passwords do not match",
		path: ["confirmPassword"],
	});

type ResetPasswordFormData = z.infer<typeof resetPasswordSchema>;

interface ResetPasswordFormProps extends React.ComponentProps<"div"> {
	token?: string;
	error?: string;
}

export function ResetPasswordForm({
	className,
	token,
	error: urlError,
	...props
}: ResetPasswordFormProps) {
	const [isLoading, setIsLoading] = useState(false);
	const [isSuccess, setIsSuccess] = useState(false);
	const [showPassword, setShowPassword] = useState(false);
	const [showConfirmPassword, setShowConfirmPassword] = useState(false);

	const {
		register,
		handleSubmit,
		formState: { errors },
	} = useForm<ResetPasswordFormData>({
		resolver: zodResolver(resetPasswordSchema),
	});

	if (urlError === "INVALID_TOKEN" || !token) {
		return (
			<div className={cn("flex flex-col gap-6", className)} {...props}>
				<div className="flex flex-col items-center gap-4 text-center">
					<div className="flex h-12 w-12 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30">
						<XCircle className="h-6 w-6 text-red-600 dark:text-red-400" />
					</div>
					<div className="flex flex-col gap-2">
						<h1 className="text-2xl font-semibold tracking-tight">
							Invalid or expired link
						</h1>
						<p className="text-sm text-muted-foreground">
							This password reset link is invalid or has expired. Please request
							a new one.
						</p>
					</div>
				</div>

				<div className="flex flex-col gap-3">
					<Link to="/auth/forgot-password">
						<Button className="w-full">Request new reset link</Button>
					</Link>
					<Link
						to="/auth/login"
						className="flex items-center justify-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
					>
						<ArrowLeft className="h-4 w-4" />
						Back to login
					</Link>
				</div>
			</div>
		);
	}

	const onSubmit = async (data: ResetPasswordFormData) => {
		try {
			setIsLoading(true);

			const result = await authClient.resetPassword({
				newPassword: data.password,
				token,
			});

			if (result.error) {
				toastManager.add({
					title: "Reset failed",
					type: "error",
					description:
						result.error.message ||
						"Failed to reset password. Please try again.",
				});
				return;
			}

			setIsSuccess(true);
			toastManager.add({
				title: "Password reset successful",
				type: "success",
				description:
					"Your password has been changed. You can now log in with your new password.",
			});
		} catch (error) {
			secureLogger.error("Reset password error:", error);
			toastManager.add({
				title: "Reset failed",
				type: "error",
				description: "An unexpected error occurred. Please try again.",
			});
		} finally {
			setIsLoading(false);
		}
	};

	if (isSuccess) {
		return (
			<div className={cn("flex flex-col gap-6", className)} {...props}>
				<div className="flex flex-col items-center gap-4 text-center">
					<div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
						<CheckCircle className="h-6 w-6 text-green-600 dark:text-green-400" />
					</div>
					<div className="flex flex-col gap-2">
						<h1 className="text-2xl font-semibold tracking-tight">
							Password reset successful
						</h1>
						<p className="text-sm text-muted-foreground">
							Your password has been changed successfully. You can now log in
							with your new password.
						</p>
					</div>
				</div>

				<Link to="/auth/login">
					<Button className="w-full">Go to login</Button>
				</Link>
			</div>
		);
	}

	return (
		<div className={cn("flex flex-col gap-6", className)} {...props}>
			<div className="flex flex-col gap-2 text-center">
				<h1 className="text-2xl font-semibold tracking-tight">
					Reset your password
				</h1>
				<p className="text-sm text-muted-foreground">
					Enter your new password below.
				</p>
			</div>

			<Form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
				<Field name="password" className="w-full">
					<FieldLabel htmlFor="password">New Password</FieldLabel>
					<div className="relative w-full">
						<Input
							id="password"
							type={showPassword ? "text" : "password"}
							placeholder="Enter your new password"
							{...register("password")}
							disabled={isLoading}
							className="w-full"
						/>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
							onClick={() => setShowPassword(!showPassword)}
						>
							{showPassword ? (
								<EyeOffIcon className=" text-muted-foreground" />
							) : (
								<EyeIcon className="h-4 w-4 text-muted-foreground" />
							)}
						</Button>
					</div>
					{errors.password && (
						<FieldError>{errors.password.message}</FieldError>
					)}
					<FieldDescription>
						Must be at least 8 characters with uppercase, lowercase, number, and
						special character.
					</FieldDescription>
				</Field>

				<Field name="confirmPassword" className="w-full">
					<FieldLabel htmlFor="confirmPassword">Confirm Password</FieldLabel>
					<div className="relative w-full">
						<Input
							id="confirmPassword"
							type={showConfirmPassword ? "text" : "password"}
							placeholder="Confirm your new password"
							{...register("confirmPassword")}
							disabled={isLoading}
							className="w-full pr-10"
						/>
						<Button
							type="button"
							variant="ghost"
							className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
							onClick={() => setShowConfirmPassword(!showConfirmPassword)}
						>
							{showConfirmPassword ? (
								<EyeOffIcon className=" text-muted-foreground" />
							) : (
								<EyeIcon className=" text-muted-foreground" />
							)}
						</Button>
					</div>
					{errors.confirmPassword && (
						<FieldError>{errors.confirmPassword.message}</FieldError>
					)}
				</Field>

				<Button type="submit" disabled={isLoading} className="w-full">
					{isLoading ? "Resetting..." : "Reset password"}
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
