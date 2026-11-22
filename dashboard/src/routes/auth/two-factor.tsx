import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { AppLogo } from "@/components/logo/app-logo";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

const redirectStorageKey = "anlyon.auth.redirect-after-two-factor";

export const Route = createFileRoute("/auth/two-factor")({
	component: TwoFactorChallengePage,
});

function redirectAfterVerification(): string {
	try {
		const redirect = sessionStorage.getItem(redirectStorageKey);
		sessionStorage.removeItem(redirectStorageKey);
		if (redirect?.startsWith("/") && !redirect.startsWith("//"))
			return redirect;
	} catch {
	}
	return "/dashboard";
}

function TwoFactorChallengePage() {
	const navigate = useNavigate();
	const [code, setCode] = useState("");
	const [useBackupCode, setUseBackupCode] = useState(false);
	const [trustDevice, setTrustDevice] = useState(true);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const codeId = useId();
	const trustDeviceLabelId = useId();

	const verify = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		setSubmitting(true);
		setError(null);
		try {
			const result = useBackupCode
				? await authClient.twoFactor.verifyBackupCode({
						code: code.trim(),
						trustDevice,
					})
				: await authClient.twoFactor.verifyTotp({
						code: code.trim(),
						trustDevice,
					});
			if (result.error) {
				setError(
					result.error.message ?? "That code could not be verified. Try again.",
				);
				return;
			}
			await navigate({ href: redirectAfterVerification() });
		} catch {
			setError("We couldn’t verify that code. Try again.");
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<div className="flex min-h-svh w-full flex-col items-center justify-center p-4 sm:p-6">
			<div className="w-full max-w-sm">
				<div className="mb-8 flex justify-center">
					<AppLogo size={32} />
				</div>
				<div className="rounded-lg  p-6 ">
					<h1 className="text-xl font-semibold tracking-tight">
						Verify it’s you
					</h1>
					<p className="mt-2 text-sm text-muted-foreground">
						Enter the code from your authenticator app to finish signing in.
					</p>
					<form className="mt-6 space-y-5" onSubmit={verify}>
						<div className="space-y-2">
							<Label htmlFor={codeId}>
								{useBackupCode ? "Backup code" : "Authenticator code"}
							</Label>
							<Input
								autoComplete="one-time-code"
								autoFocus
								id={codeId}
								inputMode={useBackupCode ? "text" : "numeric"}
								name="code"
								placeholder={
									useBackupCode ? "Enter a saved backup code…" : "123456"
								}
								spellCheck={false}
								value={code}
								onChange={(event) => setCode(event.target.value)}
							/>
							{error ? (
								<p className="text-sm text-destructive" role="alert">
									{error}
								</p>
							) : null}
						</div>
						<div className="flex items-center gap-2 text-sm">
							<Checkbox
								aria-labelledby={trustDeviceLabelId}
								checked={trustDevice}
								onCheckedChange={setTrustDevice}
							/>
							<span id={trustDeviceLabelId}>Trust this device for 30 days</span>
						</div>
						<Button
							className="w-full"
							disabled={!code.trim()}
							loading={submitting}
							type="submit"
						>
							Verify and sign in
						</Button>
						<button
							className="w-full text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
							type="button"
							onClick={() => {
								setUseBackupCode((value) => !value);
								setCode("");
								setError(null);
							}}
						>
							{useBackupCode
								? "Use an authenticator code instead"
								: "Use a backup code instead"}
						</button>
					</form>
				</div>
			</div>
		</div>
	);
}
