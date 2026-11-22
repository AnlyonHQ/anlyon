import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Check, Copy, ShieldCheck } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useId, useState } from "react";
import {
	SettingsPage,
	SettingsSection,
} from "@/components/settings/settings-page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/toast";
import { useAuth } from "@/hooks/use-auth";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/_protected/settings/security")({
	component: SecuritySettingsPage,
});

type Enrollment = { backupCodes: string[]; totpURI: string };

function errorMessage(
	error: { message?: string } | null | undefined,
	fallback: string,
) {
	return error?.message ?? fallback;
}

function copy(value: string, success: string) {
	navigator.clipboard.writeText(value).then(
		() => toast.success(success),
		() => toast.error("Couldn’t copy. Please select and copy it manually."),
	);
}

function SecuritySettingsPage() {
	const { user } = useAuth();
	const queryClient = useQueryClient();
	const [password, setPassword] = useState("");
	const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
	const [verificationCode, setVerificationCode] = useState("");
	const [showBackupCodes, setShowBackupCodes] = useState(false);
	const [busy, setBusy] = useState<
		"enable" | "verify" | "disable" | "regenerate" | null
	>(null);
	const enrollmentCodeId = useId();
	const enablePasswordId = useId();

	const refreshSession = () =>
		queryClient.invalidateQueries({ queryKey: ["auth", "session"] });
	const setup = async () => {
		setBusy("enable");
		try {
			const result = await authClient.twoFactor.enable({
				password: password || undefined,
				method: "totp",
			});
			if (result.error || !result.data || result.data.method !== "totp") {
				toast.error(
					errorMessage(result.error, "Couldn’t start two-factor setup."),
				);
				return;
			}
			setEnrollment({
				totpURI: result.data.totpURI,
				backupCodes: result.data.backupCodes,
			});
			setPassword("");
		} catch {
			toast.error("Couldn’t start two-factor setup.");
		} finally {
			setBusy(null);
		}
	};

	const confirmEnrollment = async () => {
		setBusy("verify");
		try {
			const result = await authClient.twoFactor.verifyTotp({
				code: verificationCode.trim(),
			});
			if (result.error) {
				toast.error(
					errorMessage(result.error, "That authenticator code is not valid."),
				);
				return;
			}
			await refreshSession();
			setShowBackupCodes(true);
			toast.success("Two-factor authentication is enabled");
		} catch {
			toast.error("That authenticator code is not valid.");
		} finally {
			setBusy(null);
		}
	};

	const disable = async () => {
		setBusy("disable");
		try {
			const result = await authClient.twoFactor.disable({
				password: password || undefined,
			});
			if (result.error) {
				toast.error(
					errorMessage(
						result.error,
						"Couldn’t disable two-factor authentication.",
					),
				);
				return;
			}
			setPassword("");
			await refreshSession();
			toast.success("Two-factor authentication is disabled");
		} catch {
			toast.error("Couldn’t disable two-factor authentication.");
		} finally {
			setBusy(null);
		}
	};

	const regenerateCodes = async () => {
		setBusy("regenerate");
		try {
			const result = await authClient.twoFactor.generateBackupCodes({
				password: password || undefined,
			});
			if (result.error || !result.data) {
				toast.error(
					errorMessage(result.error, "Couldn’t generate new backup codes."),
				);
				return;
			}
			setEnrollment((current) => ({
				backupCodes: result.data.backupCodes,
				totpURI: current?.totpURI ?? "",
			}));
			setPassword("");
			setShowBackupCodes(true);
			toast.success("New backup codes created. Your old codes no longer work.");
		} catch {
			toast.error("Couldn’t generate new backup codes.");
		} finally {
			setBusy(null);
		}
	};

	const secret = enrollment?.totpURI
		? (new URL(enrollment.totpURI).searchParams.get("secret") ?? "")
		: "";
	const enabled = Boolean(user?.twoFactorEnabled);

	return (
		<SettingsPage
			title="Security"
			description="Protect your account with an authenticator app and recovery codes."
		>
			<SettingsSection
				title="Authenticator app"
				description={
					enabled
						? "Two-factor authentication is active for password sign-ins."
						: "Use Google Authenticator or another TOTP-compatible app to add a sign-in check."
				}
			>
				{enabled ? (
					<div className="flex items-center gap-3 text-sm">
						<ShieldCheck
							className="size-5 text-emerald-600"
							aria-hidden="true"
						/>
						<span className="font-medium">
							Two-factor authentication is enabled
						</span>
					</div>
				) : enrollment ? (
					<div className="space-y-5">
						<div className="flex flex-col gap-5 sm:flex-row sm:items-start">
							<div className="rounded-lg bg-white p-3">
								<QRCodeSVG
									aria-label="QR code for authenticator setup"
									size={176}
									value={enrollment.totpURI}
								/>
							</div>
							<div className="space-y-3 text-sm text-muted-foreground">
								<p>
									Open Google Authenticator, select “Add a code”, then scan this
									QR code.
								</p>
								<Button
									size="sm"
									type="button"
									variant="outline"
									onClick={() => copy(secret, "Setup key copied")}
								>
									<Copy /> Copy setup key
								</Button>
							</div>
						</div>
						<div className="max-w-sm space-y-2">
							<Label htmlFor={enrollmentCodeId}>
								Enter the 6-digit code to finish setup
							</Label>
							<Input
								autoComplete="one-time-code"
								id={enrollmentCodeId}
								inputMode="numeric"
								placeholder="123456"
								value={verificationCode}
								onChange={(event) => setVerificationCode(event.target.value)}
							/>
							<Button
								disabled={!verificationCode.trim()}
								loading={busy === "verify"}
								onClick={confirmEnrollment}
							>
								Verify and enable
							</Button>
						</div>
					</div>
				) : (
					<div className="flex flex-wrap items-end gap-3">
						<div className="w-full max-w-sm space-y-2">
							<Label htmlFor={enablePasswordId}>Current password</Label>
							<Input
								autoComplete="current-password"
								id={enablePasswordId}
								type="password"
								value={password}
								onChange={(event) => setPassword(event.target.value)}
							/>
						</div>
						<Button loading={busy === "enable"} onClick={setup}>
							Set up authenticator
						</Button>
					</div>
				)}
			</SettingsSection>

			{showBackupCodes && enrollment ? (
				<SettingsSection
					title="Save your backup codes"
					description="Each code works once. Store them in a password manager or another secure location."
				>
					<div className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/30 p-4 font-mono text-sm sm:grid-cols-5">
						{enrollment.backupCodes.map((code) => (
							<span key={code}>{code}</span>
						))}
					</div>
					<div className="mt-4 flex gap-3">
						<Button
							size="sm"
							type="button"
							variant="outline"
							onClick={() =>
								copy(enrollment.backupCodes.join("\n"), "Backup codes copied")
							}
						>
							<Copy /> Copy codes
						</Button>
						<Button
							size="sm"
							type="button"
							onClick={() => setShowBackupCodes(false)}
						>
							<Check /> I saved these codes
						</Button>
					</div>
				</SettingsSection>
			) : null}

			{enabled ? (
				<SettingsSection
					title="Recovery codes"
					description="Create a fresh set if you no longer have your saved codes. This immediately invalidates the old set."
				>
					<div className="flex flex-wrap items-end gap-3">
						<Input
							className="max-w-sm"
							autoComplete="current-password"
							placeholder="Current password (if you have one)"
							type="password"
							value={password}
							onChange={(event) => setPassword(event.target.value)}
						/>
						<Button
							loading={busy === "regenerate"}
							variant="outline"
							onClick={regenerateCodes}
						>
							Generate new codes
						</Button>
					</div>
				</SettingsSection>
			) : null}

			{enabled ? (
				<SettingsSection
					title="Turn off two-factor authentication"
					description="You’ll only need your password to sign in after this is disabled."
					variant="danger"
				>
					<div className="flex flex-wrap items-end gap-3">
						<Input
							className="max-w-sm"
							autoComplete="current-password"
							placeholder="Current password (if you have one)"
							type="password"
							value={password}
							onChange={(event) => setPassword(event.target.value)}
						/>
						<Button
							loading={busy === "disable"}
							variant="destructive"
							onClick={disable}
						>
							Disable 2FA
						</Button>
					</div>
				</SettingsSection>
			) : null}
		</SettingsPage>
	);
}
