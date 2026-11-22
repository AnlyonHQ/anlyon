"""Governed agent, end to end: an operator scopes a deny, a restricted runtime key runs into it.

1. An OPERATOR credential (policies:write) creates a policy that denies ``refund_order``.
2. The agent's RUNTIME key invokes ``get_order`` and it succeeds.
3. The same key invokes ``refund_order`` and gets a structured explanation of the denial.

Policy configuration belongs in deployment/setup code with the operator credential. The running agent
holds only its restricted key, and that key cannot rewrite the rules that govern it.

Run: ANLYON_BASE_URL=... ANLYON_OPERATOR_KEY=... ANLYON_RUNTIME_KEY=... python examples/policy_governance.py
Needs actions named ``get_order`` and ``refund_order`` in the credentials' environment.
"""

from __future__ import annotations

import os

from anlyon import AnlyonError, Client, SignOffRequiredError

base_url = os.environ.get("ANLYON_BASE_URL", "https://api.anlyon.com")


def main() -> None:
    with (
        Client(api_key=os.environ["ANLYON_OPERATOR_KEY"], base_url=base_url) as operator,
        Client(api_key=os.environ["ANLYON_RUNTIME_KEY"], base_url=base_url) as runtime,
    ):
        identity = runtime.auth.identity().data
        assert "actions:invoke" in identity["scopes"], "runtime key needs actions:invoke"
        assert "policies:write" not in identity["scopes"], (
            "runtime key must not hold policies:write"
        )
        print(f"runtime key {identity['apiKeyId']} in environment {identity['environmentId']}")

        policy = operator.approval_policies.create(
            name="refund_order_denied",
            match_kind="action",
            match_action_name="refund_order",
            effect="auto_deny",
        ).data
        print(f"created {policy['id']}: applies to {policy['scope']}")

        try:
            read = runtime.actions.invoke("get_order", {"orderId": "ord_1"}).data
            assert read["status"] == "succeeded"
            print("get_order: succeeded")

            refund = runtime.actions.invoke("refund_order", {"orderId": "ord_1"}).data
            assert refund["status"] == "denied"
            assert refund["responseStatus"] is None
            assert refund["decision"]["code"] == "POLICY_DENIED"
            assert refund["decision"]["policy"]["name"] == "refund_order_denied"
            print(f"refund_order: {refund['decision']['explanation']}")

            try:
                runtime.approval_policies.disable(policy["id"])
            except AnlyonError as error:
                assert error.status == 403
                print("runtime key was refused when it tried to disable the policy")
            else:
                raise AssertionError("runtime key was allowed to change policy")
        finally:
            try:
                operator.approval_policies.delete(policy["id"])
            except SignOffRequiredError as error:
                print(f"removing the policy needs a workspace admin's sign-off: {error.sign_off_url}")


if __name__ == "__main__":
    main()
