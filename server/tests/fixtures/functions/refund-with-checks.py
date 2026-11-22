# Refund an order after checking it was paid, then tell the customer.
async def run(input, api):
    order = await api.read("lookup-order", {"id": input["order"]})
    if not order["ok"] or order["result"]["status"] != "paid":
        return {"refunded": False}
    refund = await api.invoke('refund', {"order": input["order"], "amount": input["amount"]})
    await api.invoke("""send-email""", {"to": order["result"]["email"], "template": "refunded"})
    return {"refunded": refund["ok"]}
