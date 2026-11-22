/* @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	EffectDetail,
	EffectGrade,
	EffectVerification,
} from "@/lib/types";

const idle = { mutate: vi.fn(), isPending: false };

vi.mock("@/hooks/api/use-permissions", () => ({
	useCan: () => () => true,
}));

vi.mock("@/hooks/api/use-effects", () => ({
	useReconcileEffect: () => idle,
	useReplayEffect: () => idle,
	useResolveEffect: () => idle,
	useAddEffectNote: () => idle,
}));

vi.mock("@/hooks/api/use-actor-names", () => ({
	useActorNames: () => () => ({ text: "Someone", title: "Someone" }),
}));

import {
	EffectDetailView,
	GRADE_LABEL,
	GRADE_MEANING,
	GRADES,
	GradePill,
	verificationLabel,
} from "./effect-detail";

afterEach(cleanup);

function effect(overrides: Partial<EffectDetail> = {}): EffectDetail {
	return {
		id: "eff_1",
		invocationId: "inv_1",
		operationKey: "op-1",
		environmentId: "env_1",
		action: { name: "send_email", versionId: "acv_1" },
		adapter: { type: "http.declared", version: "1" },
		stage: "settled",
		outcome: "succeeded",
		partialEffect: "none",
		grade: "acknowledged",
		verification: "manual",
		providerReference: null,
		target: { resourceKey: "http:api.example.com/emails" },
		impact: [{ dimension: "emails", amount: 3, bound: "exact" }],
		previewId: null,
		approvalId: null,
		bindingDigest: null,
		dependsOn: [],
		compensates: null,
		rejectionReason: null,
		unresolvedExposure: false,
		reconciliation: { attempts: 0, nextAt: null, exhausted: false },
		createdAt: "2026-10-01T00:00:00.000Z",
		firstDispatchedAt: "2026-10-01T00:00:01.000Z",
		outcomeAt: "2026-10-01T00:00:02.000Z",
		updatedAt: "2026-10-01T00:00:02.000Z",
		request: {},
		capabilities: {},
		attempts: [],
		evidence: [],
		reservations: [
			{
				limitId: "lim_2",
				name: "Daily email cap",
				dimension: "emails",
				currency: null,
				period: "day:2026-10-01",
				amount: 3,
				state: "settled",
				exposure: null,
				settled: 3,
				released: 0,
			},
		],
		preview: null,
		...overrides,
	};
}

describe("receipt grades", () => {
	it("gives every grade a label and its meaning in one sentence", () => {
		expect(GRADE_MEANING).toEqual({
			confirmed: "A read-back matched the request.",
			acknowledged: "The provider accepted the request. Nothing read it back.",
			unknown:
				"No usable response. Anlyon does not send it again. It stays unknown until a read-back or an operator settles it.",
			failed: "The provider rejected the request, or it never left Anlyon.",
			refused: "Anlyon refused it at dispatch.",
			denied: "The approval was denied.",
			pending: "No receipt yet.",
		});
		expect([...GRADES].sort()).toEqual(Object.keys(GRADE_MEANING).sort());
		for (const grade of GRADES) expect(GRADE_LABEL[grade]).toBeTruthy();
	});

	it("renders the grade as a word, not only a colour", () => {
		for (const grade of GRADES) {
			const { unmount } = render(<GradePill grade={grade} />);
			const pill = screen.getByText(GRADE_LABEL[grade]);
			expect(pill.getAttribute("title")).toBe(GRADE_MEANING[grade]);
			unmount();
		}
	});

	it("shows an unrecognised grade as it came, without breaking", () => {
		render(<GradePill grade={"later" as EffectGrade} />);
		expect(screen.getByText("later")).toBeTruthy();
	});
});

describe("verification label", () => {
	it("says verified only when a read-back confirmed the outcome", () => {
		expect(
			verificationLabel({ verification: "provider", grade: "confirmed" }),
		).toBe("Verified by provider");
		expect(
			verificationLabel({ verification: "provider", grade: "acknowledged" }),
		).toBe("Reported by provider");
		expect(
			verificationLabel({ verification: "provider", grade: "failed" }),
		).toBe("Reported by provider");
		expect(
			verificationLabel({ verification: "manual", grade: "acknowledged" }),
		).toBe("Resolved manually");
		expect(
			verificationLabel({ verification: "unverified", grade: "unknown" }),
		).toBe("Not yet verified");
	});

	it("does not call an acknowledged receipt verified in the detail view", () => {
		render(
			<EffectDetailView
				effect={effect({ verification: "provider", grade: "acknowledged" })}
				workspaceId="ws"
			/>,
		);
		expect(screen.getByText("Reported by provider")).toBeTruthy();
		expect(screen.queryByText("Verified by provider")).toBeNull();
	});
});

describe("EffectDetailView receipt", () => {
	it("shows the grade, its meaning, and keeps the verification label", () => {
		render(<EffectDetailView effect={effect()} workspaceId="ws" />);
		expect(screen.getByText("Acknowledged")).toBeTruthy();
		expect(screen.getByTestId("grade-meaning").textContent).toBe(
			"The provider accepted the request. Nothing read it back.",
		);
		expect(screen.getByText("Resolved manually")).toBeTruthy();
	});

	it("counts a declared unit in its own name, in the headline and the reservations", () => {
		render(<EffectDetailView effect={effect()} workspaceId="ws" />);
		expect(screen.getAllByText("3 emails")).toHaveLength(2);
		expect(
			screen.getByText(/settled 3 emails · released 0 emails/),
		).toBeTruthy();
	});
});

const EVERY_VERIFICATION: Record<EffectVerification, true> = {
	provider: true,
	manual: true,
	unverified: true,
	not_dispatched: true,
};
const VERIFICATIONS = Object.keys(EVERY_VERIFICATION) as EffectVerification[];
const CASES = GRADES.flatMap((grade) =>
	VERIFICATIONS.map((verification) => ({ grade, verification })),
);

describe("verification label, for every grade and verification", () => {
	it("covers the seven grades and the four verification values", () => {
		expect(GRADES).toHaveLength(7);
		expect(CASES).toHaveLength(28);
	});

	it.each(CASES)(
		"$grade and $verification: verified only when confirmed by the provider",
		({ grade, verification }) => {
			const verified = grade === "confirmed" && verification === "provider";
			const label = verificationLabel({ grade, verification });
			expect(label === "Verified by provider").toBe(verified);
			expect(/verified by/i.test(label)).toBe(verified);

			const { container } = render(
				<EffectDetailView
					effect={effect({ grade, verification })}
					workspaceId="ws"
				/>,
			);
			expect(
				(container.textContent ?? "").includes("Verified by provider"),
			).toBe(verified);
			expect(screen.getByTestId("grade-meaning").textContent).toBe(
				GRADE_MEANING[grade],
			);
		},
	);
});
