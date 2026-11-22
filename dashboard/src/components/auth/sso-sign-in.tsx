import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { startSsoSignIn } from "@/lib/sso";

export function SsoSignInForm({
	defaultEmail = "",
	redirectPath,
	notice,
	onBack,
}: {
	defaultEmail?: string;
	redirectPath: string;
	notice?: string;
	onBack: () => void;
}) {
	const emailId = useId();
	const [email, setEmail] = useState(defaultEmail);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	const submit = async () => {
		if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
			setError("Enter your work email address");
			return;
		}
		setError(null);
		setPending(true);
		try {
			const result = await startSsoSignIn(email.trim(), redirectPath);
			if (!result.ok) setError(result.message);
		} catch {
			setError("Single sign-on could not start. Try again.");
		} finally {
			setPending(false);
		}
	};

	return (
		<Form
			onSubmit={(event) => {
				event.preventDefault();
				void submit();
			}}
			className="flex flex-col gap-4"
		>
			{notice ? (
				<p className="rounded-lg border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
					{notice}
				</p>
			) : null}
			<Field name="sso-email">
				<FieldLabel htmlFor={emailId}>Work email</FieldLabel>
				<Input
					id={emailId}
					type="email"
					autoComplete="email"
					placeholder="you@company.com"
					value={email}
					onChange={(event) => setEmail(event.target.value)}
					disabled={pending}
				/>
				{error ? (
					<p role="alert" className="text-destructive-foreground text-xs">
						{error}
					</p>
				) : null}
			</Field>
			<Button
				type="submit"
				loading={pending}
				disabled={pending}
				className="w-full"
			>
				Continue with SSO
			</Button>
			<Button type="button" variant="ghost" onClick={onBack} disabled={pending}>
				Use another sign-in method
			</Button>
		</Form>
	);
}
