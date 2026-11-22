import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { cn } from "@/lib/utils";

export type SampleLanguage = "typescript" | "python" | "curl";

const LABELS: Record<SampleLanguage, string> = {
	typescript: "TypeScript",
	python: "Python",
	curl: "HTTP",
};

export function CodeSample({
	snippets,
	label = "Language",
}: {
	snippets: Partial<Record<SampleLanguage, string>>;
	label?: string;
}) {
	const languages = (Object.keys(LABELS) as SampleLanguage[]).filter(
		(language) => snippets[language],
	);
	const [language, setLanguage] = useState<SampleLanguage>(
		languages[0] ?? "typescript",
	);
	const [copied, setCopied] = useState(false);
	const text = snippets[language] ?? "";
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
		}
	};
	return (
		<div className="overflow-hidden rounded-md border">
			<div className="flex h-9 items-center justify-between gap-2 border-b bg-muted/40 ps-1 pe-1">
				<SegmentedControl
					className="flex items-center gap-0.5"
					label={label}
					onChange={(value) => {
						setLanguage(value);
						setCopied(false);
					}}
					options={languages.map((value) => ({ value, label: LABELS[value] }))}
					segmentClassName={(_option, on) =>
						cn(
							"h-7 rounded-[5px] px-2 font-medium text-xs transition-colors",
							on
								? "bg-background text-foreground shadow-xs ring-1 ring-border/60"
								: "text-muted-foreground hover:text-foreground",
						)
					}
					value={language}
				/>
				<Button onClick={copy} size="xs" variant="ghost">
					{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
					{copied ? "Copied" : "Copy"}
				</Button>
			</div>
			<pre className="overflow-x-auto bg-card p-3 font-mono text-[12px] leading-5">
				{text}
			</pre>
		</div>
	);
}
