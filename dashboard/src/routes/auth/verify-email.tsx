import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { CheckCircle, Loader2, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { toastManager } from "@/components/ui/toast";
import { authClient } from "@/lib/auth-client";
import { secureLogger } from "@/lib/logger";
import {
	fetchFirstPartyClient,
	parseAuthorizeRequest,
	type VerifiedDestination,
	verifiedDestination,
} from "@/lib/oauth-return";
import { safeReturnPath } from "@/lib/security";

export const Route = createFileRoute("/auth/verify-email")({
	component: RouteComponent,
	validateSearch: (search: Record<string, unknown>) => ({
		token: (search.token as string) || "",
		oauth_query:
			typeof search.oauth_query === "string" ? search.oauth_query : undefined,
		return_to:
			typeof search.return_to === "string" ? search.return_to : undefined,
	}),
});

function RouteComponent() {
	const navigate = useNavigate();
	const {
		token,
		oauth_query: oauthQuery,
		return_to: returnTo,
	} = Route.useSearch();
	const [destination, setDestination] = useState<VerifiedDestination>({
		kind: "login",
	});
	const [isVerifying, setIsVerifying] = useState(false);
	const [verificationStatus, setVerificationStatus] = useState<
		"idle" | "success" | "error"
	>("idle");
	const [errorMessage, setErrorMessage] = useState("");

	// biome-ignore lint/correctness/useExhaustiveDependencies: verifyEmail is re-created each render; depending on it would re-fire the async verification while status is still "idle".
	useEffect(() => {
		if (token && verificationStatus === "idle") {
			verifyEmail(token);
		}
	}, [token, verificationStatus]);

	const resolveDestination = async (): Promise<VerifiedDestination> => {
		const request = oauthQuery ? parseAuthorizeRequest(oauthQuery) : null;
		const firstParty = request
			? await fetchFirstPartyClient(request.clientId)
			: null;
		return verifiedDestination(request, firstParty, safeReturnPath(returnTo));
	};

	const goToDestination = (next: VerifiedDestination) => {
		if (next.kind === "first-party") window.location.assign(next.url);
		else if (next.kind === "authorize") window.location.assign(next.to);
		else
			navigate({
				to: "/auth/login",
				search: next.returnTo ? { redirect: next.returnTo } : {},
			});
	};

	const verifyEmail = async (verificationToken: string) => {
		try {
			setIsVerifying(true);
			setVerificationStatus("idle");

			const result = await authClient.verifyEmail({
				query: {
					token: verificationToken,
				},
			});

			if (result.error) {
				setVerificationStatus("error");
				setErrorMessage(result.error.message || "Verification failed");
				toastManager.add({
					title: "Verification Failed",
					description:
						result.error.message ||
						"Email verification failed. Please try again.",
					type: "error",
				});
			} else {
				const next = await resolveDestination();
				setDestination(next);
				setVerificationStatus("success");
				toastManager.add({
					title: "Email Verified!",
					description:
						next.kind === "first-party"
							? `Taking you back to ${next.displayName}.`
							: "Your email has been successfully verified. You can now log in.",
					type: "success",
				});

				setTimeout(() => {
					goToDestination(next);
				}, 2000);
			}
		} catch (error) {
			secureLogger.error("Email verification error:", error);
			setVerificationStatus("error");
			setErrorMessage("An unexpected error occurred during verification");
			toastManager.add({
				title: "Verification Error",
				description: "An unexpected error occurred. Please try again.",
				type: "error",
			});
		} finally {
			setIsVerifying(false);
		}
	};

	const handleRetry = () => {
		if (token) {
			verifyEmail(token);
		}
	};

	if (!token) {
		return (
			<div className="min-h-screen w-full min-w-0 flex items-center justify-center overflow-x-hidden bg-gray-50 p-4">
				<Card className="w-full max-w-md min-w-0">
					<CardHeader className="text-center">
						<XCircle className="mx-auto h-12 w-12 text-red-500 mb-4" />
						<CardTitle className="text-xl text-red-700">
							Invalid Verification Link
						</CardTitle>
						<CardDescription>
							No verification token found in the URL. Please check your email
							for a valid verification link.
						</CardDescription>
					</CardHeader>
					<CardContent className="text-center">
						<Button onClick={() => navigate({ to: "/auth/login" })}>
							Go to Login
						</Button>
					</CardContent>
				</Card>
			</div>
		);
	}

	return (
		<div className="min-h-screen w-full min-w-0 flex items-center justify-center overflow-x-hidden bg-gray-50 p-4">
			<Card className="w-full max-w-md min-w-0">
				<CardHeader className="text-center">
					{verificationStatus === "idle" && isVerifying && (
						<>
							<Loader2 className="mx-auto h-12 w-12 text-blue-500 mb-4 animate-spin" />
							<CardTitle className="text-xl">Verifying Your Email</CardTitle>
							<CardDescription>
								Please wait while we verify your email address...
							</CardDescription>
						</>
					)}

					{verificationStatus === "success" && (
						<>
							<CheckCircle className="mx-auto h-12 w-12 text-green-500 mb-4" />
							<CardTitle className="text-xl text-green-700">
								Email Verified!
							</CardTitle>
							<CardDescription>
								{destination.kind === "first-party"
									? `Your email is verified. Taking you back to ${destination.displayName}.`
									: "Your email has been successfully verified. You'll be redirected to the login page shortly."}
							</CardDescription>
						</>
					)}

					{verificationStatus === "error" && (
						<>
							<XCircle className="mx-auto h-12 w-12 text-red-500 mb-4" />
							<CardTitle className="text-xl text-red-700">
								Verification Failed
							</CardTitle>
							<CardDescription>
								{errorMessage ||
									"Email verification failed. Please try again or request a new verification email."}
							</CardDescription>
						</>
					)}
				</CardHeader>

				<CardContent className="text-center space-y-4">
					{verificationStatus === "error" && (
						<div className="space-y-2">
							<Button
								onClick={handleRetry}
								disabled={isVerifying}
								className="w-full"
							>
								{isVerifying ? (
									<>
										<Loader2 className="mr-2 h-4 w-4 animate-spin" />
										Retrying...
									</>
								) : (
									"Try Again"
								)}
							</Button>
							<Button
								variant="outline"
								onClick={() => navigate({ to: "/auth/login" })}
								className="w-full"
							>
								Go to Login
							</Button>
						</div>
					)}

					{verificationStatus === "success" && (
						<Button
							onClick={() => goToDestination(destination)}
							className="w-full"
						>
							{destination.kind === "first-party"
								? `Continue to ${destination.displayName}`
								: "Continue to Login"}
						</Button>
					)}
				</CardContent>
			</Card>
		</div>
	);
}
