import { useId } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import type { McpSignIn } from "@/hooks/api/use-mcp-upstreams";
import {
	anlyonClientAvailable,
	type CredentialForm,
	type CredentialHeader,
	hostOf,
	type OAuthForm,
	secretNameFor,
} from "@/lib/mcp-servers";
import type { Secret } from "@/lib/types";
import { CopyValue } from "./copy-value";
import { ExistingSecretField, NewSecretFields } from "./secret-field";

function Instruction({
	number,
	title,
	children,
}: {
	number: number;
	title: string;
	children: React.ReactNode;
}) {
	return (
		<li className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2">
			<span
				aria-hidden="true"
				className="pt-px font-mono text-[12px] text-muted-foreground tabular-nums"
			>
				{number}.
			</span>
			<div className="min-w-0">
				<p className="font-medium text-[13px]">{title}</p>
				<div className="mt-2 flex flex-col gap-2">{children}</div>
			</div>
		</li>
	);
}

function ClientChoice({
	signIn,
	form,
	onChange,
}: {
	signIn: McpSignIn;
	form: OAuthForm;
	onChange: (form: OAuthForm) => void;
}) {
	return (
		<RadioGroup
			aria-label="OAuth client"
			className="gap-2"
			onValueChange={(value) =>
				onChange({ ...form, anlyonClient: value === "anlyon" })
			}
			value={form.anlyonClient ? "anlyon" : "own"}
		>
			<Label className="flex items-center gap-2 font-normal">
				<Radio value="anlyon" />
				Use Anlyon's client: {hostOf(signIn.issuer)} accepts it, so there is
				nothing to set up at the vendor
			</Label>
			<Label className="flex items-center gap-2 font-normal">
				<Radio value="own" />
				Use an OAuth app of my own
			</Label>
		</RadioGroup>
	);
}

export function OAuthSetup({
	signIn,
	form,
	onChange,
	secrets,
	serverName,
}: {
	signIn: McpSignIn;
	form: OAuthForm;
	onChange: (form: OAuthForm) => void;
	secrets: readonly Secret[];
	serverName: string;
}) {
	const id = useId();
	const issuerHost = hostOf(signIn.issuer);
	if (!signIn.redirectUri) {
		return (
			<Alert role="alert" variant="error">
				<AlertTitle>This deployment cannot sign people in yet</AlertTitle>
				<AlertDescription>
					Connected accounts are not configured on it, so it has no callback URL
					to give the vendor. An admin needs to set that up before an OAuth
					server can be added.
				</AlertDescription>
			</Alert>
		);
	}
	const secretMode = form.secret?.mode ?? "public";
	const scopes = signIn.scopesSupported;
	return (
		<div className="flex flex-col gap-5">
			{anlyonClientAvailable(signIn) ? (
				<ClientChoice form={form} onChange={onChange} signIn={signIn} />
			) : null}
			<ol className="flex flex-col gap-5">
				{form.anlyonClient ? null : (
					<>
						<Instruction
							number={1}
							title={`Create an OAuth app at the vendor, for sign-in through ${issuerHost}`}
						>
							<p className="text-[13px] text-muted-foreground">
								When it asks for a callback or redirect URL, give it this one.
							</p>
							<CopyValue label="callback URL" value={signIn.redirectUri} />
						</Instruction>
						<Instruction number={2} title="Paste the client id it gives you">
							<Input
								aria-label="Client id"
								autoComplete="off"
								className="font-mono sm:max-w-sm"
								onChange={(event) =>
									onChange({ ...form, clientId: event.target.value })
								}
								spellCheck={false}
								value={form.clientId}
							/>
						</Instruction>
						<Instruction number={3} title="Add its client secret">
							<RadioGroup
								aria-label="Client secret"
								className="gap-2"
								onValueChange={(mode) =>
									onChange({
										...form,
										secret:
											mode === "new"
												? {
														mode: "new",
														name: secretNameFor(serverName, "CLIENT_SECRET"),
														value: "",
													}
												: mode === "existing"
													? { mode: "existing", name: "" }
													: null,
									})
								}
								value={secretMode}
							>
								<Label className="flex items-center gap-2 font-normal">
									<Radio value="new" />
									Paste it, and store it in the vault
								</Label>
								<Label className="flex items-center gap-2 font-normal">
									<Radio value="existing" />
									Use a secret already in the vault
								</Label>
								<Label className="flex items-center gap-2 font-normal">
									<Radio value="public" />
									It has none: this is a public client
								</Label>
							</RadioGroup>
							{form.secret?.mode === "new" ? (
								<NewSecretFields
									host={signIn.tokenHost}
									onChange={(secret) => onChange({ ...form, secret })}
									value={form.secret}
									valueLabel="Client secret"
								/>
							) : null}
							{form.secret?.mode === "existing" ? (
								<ExistingSecretField
									host={signIn.tokenHost}
									name={form.secret.name}
									onChange={(name) =>
										onChange({ ...form, secret: { mode: "existing", name } })
									}
									secrets={secrets}
								/>
							) : null}
							{form.secret === null ? (
								<p className="text-muted-foreground text-xs">
									Only choose this if the vendor gave you no secret. Sign-in
									then relies on the client id and PKCE alone.
								</p>
							) : null}
						</Instruction>
					</>
				)}
				<Instruction
					number={form.anlyonClient ? 1 : 4}
					title="Choose what Anlyon may ask for"
				>
					{scopes.length === 0 ? (
						<p className="text-[13px] text-muted-foreground">
							This server advertises no scopes, so Anlyon asks for none and the
							vendor decides what a token may do.
						</p>
					) : (
						<>
							<p className="max-w-[38rem] text-[13px] text-muted-foreground">
								Everyone who signs in is asked for exactly these. Pick the
								fewest your tools need: you can adopt a tool that needs a scope
								you left out, but its calls will fail.
							</p>
							<fieldset
								aria-label="Scopes"
								className="grid max-h-64 gap-x-4 gap-y-1.5 overflow-y-auto sm:grid-cols-2"
							>
								{scopes.map((scope) => {
									const on = form.scopes.includes(scope);
									const inputId = `${id}-${scope}`;
									return (
										<div
											className="flex min-w-0 items-center gap-2"
											key={scope}
										>
											<Checkbox
												checked={on}
												id={inputId}
												onCheckedChange={(checked) =>
													onChange({
														...form,
														scopes:
															checked === true
																? [...form.scopes, scope]
																: form.scopes.filter((s) => s !== scope),
													})
												}
											/>
											<Label
												className="min-w-0 break-all font-mono font-normal text-xs"
												htmlFor={inputId}
											>
												{scope}
											</Label>
										</div>
									);
								})}
							</fieldset>
						</>
					)}
				</Instruction>
			</ol>
		</div>
	);
}

export function CredentialSetup({
	host,
	form,
	onChange,
	secrets,
	serverName,
}: {
	host: string;
	form: CredentialForm;
	onChange: (form: CredentialForm) => void;
	secrets: readonly Secret[];
	serverName: string;
}) {
	const id = useId();
	return (
		<div className="flex flex-col gap-4">
			<RadioGroup
				aria-label="Credential"
				className="gap-2"
				onValueChange={(mode) =>
					onChange({
						...form,
						secret:
							mode === "new"
								? {
										mode: "new",
										name: secretNameFor(serverName, "MCP_TOKEN"),
										value: "",
									}
								: { mode: "existing", name: "" },
					})
				}
				value={form.secret.mode}
			>
				<Label className="flex items-center gap-2 font-normal">
					<Radio value="new" />
					Paste its key or token, and store it in the vault
				</Label>
				<Label className="flex items-center gap-2 font-normal">
					<Radio value="existing" />
					Use a secret already in the vault
				</Label>
			</RadioGroup>
			{form.secret.mode === "new" ? (
				<NewSecretFields
					host={host}
					onChange={(secret) => onChange({ ...form, secret })}
					value={form.secret}
					valueLabel="Key or token"
				/>
			) : (
				<ExistingSecretField
					host={host}
					name={form.secret.name}
					onChange={(name) =>
						onChange({ ...form, secret: { mode: "existing", name } })
					}
					secrets={secrets}
				/>
			)}
			<div className="space-y-1.5">
				<Label htmlFor={`${id}-header`}>How the server takes it</Label>
				<NativeSelect
					className="w-full font-mono sm:max-w-sm"
					id={`${id}-header`}
					onChange={(event) =>
						onChange({
							...form,
							header: event.target.value as CredentialHeader,
						})
					}
					value={form.header}
				>
					<NativeSelectOption value="bearer">
						Authorization: Bearer ...
					</NativeSelectOption>
					<NativeSelectOption value="x-api-key">
						X-API-Key: ...
					</NativeSelectOption>
				</NativeSelect>
			</div>
		</div>
	);
}

export function ContinueRow({
	problem,
	onContinue,
	children,
}: {
	problem: string | null;
	onContinue: () => void;
	children?: React.ReactNode;
}) {
	return (
		<div className="flex flex-wrap items-center gap-3">
			<Button disabled={problem !== null} onClick={onContinue} size="sm">
				Continue
			</Button>
			{children}
			{problem ? (
				<p className="min-w-0 flex-1 basis-60 text-muted-foreground text-xs">
					{problem}
				</p>
			) : null}
		</div>
	);
}
