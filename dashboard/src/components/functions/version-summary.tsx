import {
	PageCard,
	PageCardBody,
	PageCardHeader,
} from "@/components/actions/page-card";
import { Badge } from "@/components/ui/badge";
import { aiReviewNote, RISK_TIER_LABEL, sourceWarnings } from "@/lib/functions";
import type {
	FunctionSourceFindings,
	FunctionVersionReview,
} from "@/lib/types";

export function VersionReview({
	review,
}: {
	review: FunctionVersionReview | null;
}) {
	const note = aiReviewNote(review?.ai);
	const ai = review?.ai;
	return (
		<PageCard>
			<PageCardHeader
				titleAs="h3"
				description="Advice shown to whoever approves this function's plans. Nothing here allows or refuses a call."
				title="Review"
			/>
			<PageCardBody className="space-y-5">
				<section aria-label="Source findings" className="space-y-2">
					<h3 className="font-medium text-sm">Source findings</h3>
					{review ? (
						<FindingsList findings={review.ast} />
					) : (
						<p className="text-muted-foreground text-sm">
							This version has no source findings.
						</p>
					)}
				</section>
				<section aria-label="AI review" className="space-y-2">
					<h3 className="font-medium text-sm">AI review</h3>
					{note || !ai ? (
						<p className="text-muted-foreground text-sm">{note}</p>
					) : (
						<div className="space-y-3 text-sm">
							{ai.summary ? <p>{ai.summary}</p> : null}
							{ai.suggestedRiskTier ? (
								<p>
									<span className="text-muted-foreground">
										Suggested risk tier
									</span>{" "}
									<Badge variant="outline">
										{RISK_TIER_LABEL[ai.suggestedRiskTier] ??
											ai.suggestedRiskTier}
									</Badge>
								</p>
							) : null}
							{ai.riskyPatterns.length > 0 ? (
								<ul aria-label="Risky patterns" className="space-y-1">
									{ai.riskyPatterns.map((pattern) => (
										<li
											className="flex gap-2"
											key={`${pattern.pattern}-${pattern.description}`}
										>
											<Badge className="shrink-0" variant="warning">
												{pattern.pattern.replaceAll("_", " ")}
											</Badge>
											<span>{pattern.description}</span>
										</li>
									))}
								</ul>
							) : (
								<p className="text-muted-foreground">
									The review found no risky patterns.
								</p>
							)}
							{ai.truncated ? (
								<p className="text-muted-foreground text-xs">
									The source was too long to review whole. The review covers its
									start.
								</p>
							) : null}
						</div>
					)}
				</section>
			</PageCardBody>
		</PageCard>
	);
}

export function FindingsList({
	findings,
}: {
	findings: FunctionSourceFindings;
}) {
	const warnings = sourceWarnings(findings);
	return (
		<div className="space-y-3 text-sm">
			{findings.calls.length > 0 ? (
				<ul aria-label="Action calls in the source" className="space-y-1">
					{findings.calls.map((call) => (
						<li
							className="flex items-center gap-2"
							key={`${call.kind}-${call.action}-${call.line}`}
						>
							<span className="w-14 text-muted-foreground text-xs tabular-nums">
								line {call.line}
							</span>
							<span className="font-mono text-[13px]">
								anlyon.{call.kind}("{call.action}")
							</span>
						</li>
					))}
				</ul>
			) : findings.parsed ? (
				<p className="text-muted-foreground">
					The source makes no literal action calls.
				</p>
			) : null}
			{warnings.length > 0 ? (
				<ul aria-label="Warnings" className="space-y-1.5">
					{warnings.map((warning) => (
						<li
							className="flex gap-2 text-warning-foreground"
							key={`${warning.kind}-${warning.line}-${warning.message}`}
						>
							<span className="w-14 shrink-0 text-xs tabular-nums">
								{warning.line !== null ? `line ${warning.line}` : ""}
							</span>
							<span>{warning.message}</span>
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}

export function NameBadges({ names }: { names: string[] }) {
	if (names.length === 0) {
		return <span className="text-muted-foreground">None</span>;
	}
	return (
		<span className="inline-flex flex-wrap gap-1">
			{names.map((name) => (
				<Badge className="font-mono" key={name} variant="soft">
					{name}
				</Badge>
			))}
		</span>
	);
}
