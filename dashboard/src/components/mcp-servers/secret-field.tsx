import { useId } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import { type SecretChoice, secretFit } from "@/lib/mcp-servers";
import type { Secret } from "@/lib/types";

export function NewSecretFields({
	value,
	host,
	valueLabel,
	onChange,
}: {
	value: Extract<SecretChoice, { mode: "new" }>;
	host: string;
	valueLabel: string;
	onChange: (next: SecretChoice) => void;
}) {
	const id = useId();
	return (
		<div className="flex flex-col gap-2">
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="space-y-1.5">
					<Label htmlFor={`${id}-value`}>{valueLabel}</Label>
					<Input
						autoComplete="off"
						className="font-mono"
						id={`${id}-value`}
						onChange={(event) =>
							onChange({ ...value, value: event.target.value })
						}
						type="password"
						value={value.value}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor={`${id}-name`}>Save it as</Label>
					<Input
						autoComplete="off"
						className="font-mono"
						id={`${id}-name`}
						onChange={(event) =>
							onChange({ ...value, name: event.target.value.toUpperCase() })
						}
						spellCheck={false}
						value={value.name}
					/>
				</div>
			</div>
			<p className="text-muted-foreground text-xs">
				Saved in the vault when you add the server, and it can never be read
				back. Anlyon may send it only to{" "}
				<code className="font-mono" translate="no">
					{host}
				</code>
				, as its one allowed host.
			</p>
		</div>
	);
}

export function ExistingSecretField({
	name,
	secrets,
	host,
	onChange,
}: {
	name: string;
	secrets: readonly Secret[];
	host: string;
	onChange: (name: string) => void;
}) {
	const id = useId();
	const stored = secrets.filter((secret) => secret.kind !== "connection");
	const chosen = stored.find((secret) => secret.name === name);
	const fit = chosen ? secretFit(chosen, host) : null;
	return (
		<div className="space-y-1.5">
			<Label htmlFor={id}>Secret</Label>
			<NativeSelect
				className="w-full font-mono sm:max-w-sm"
				id={id}
				onChange={(event) => onChange(event.target.value)}
				value={name}
			>
				<NativeSelectOption value="">Choose a secret</NativeSelectOption>
				{stored.map((secret) => (
					<NativeSelectOption key={secret.id} value={secret.name}>
						{secret.name}
					</NativeSelectOption>
				))}
			</NativeSelect>
			{chosen && fit === "bound" ? (
				<p className="text-muted-foreground text-xs">
					May be sent to {chosen.allowedHosts?.join(", ")}, which includes{" "}
					{host}.
				</p>
			) : null}
			{chosen && fit === "anywhere" ? (
				<p className="text-warning-foreground text-xs">
					{chosen.name} may be sent to any public host, so nothing holds it to{" "}
					{host}. Limit it on the{" "}
					<a
						className="underline underline-offset-2"
						href="/actions/secrets"
						rel="noopener"
						target="_blank"
					>
						Secrets page
					</a>
					, or paste it as a new secret here.
				</p>
			) : null}
			{chosen && fit === "elsewhere" ? (
				<p className="text-destructive text-xs" role="alert">
					{chosen.name} may only be sent to {chosen.allowedHosts?.join(", ")}.
					Add {host} on the{" "}
					<a
						className="underline underline-offset-2"
						href="/actions/secrets"
						rel="noopener"
						target="_blank"
					>
						Secrets page
					</a>
					, or use another secret.
				</p>
			) : null}
			{chosen && fit === "closed" ? (
				<p className="text-destructive text-xs" role="alert">
					{chosen.name} comes from your secret store and has no allowed hosts,
					so it is sent nowhere. Add {host} to it on the{" "}
					<a
						className="underline underline-offset-2"
						href="/actions/secrets"
						rel="noopener"
						target="_blank"
					>
						Secrets page
					</a>
					.
				</p>
			) : null}
		</div>
	);
}
