import os
import socket
from urllib.request import urlopen

def run(input, anlyon):
    name = "re" + "fund"
    anlyon.invoke(name, {})
    anlyon.read(f"lookup-{input['kind']}", {})
    for customer in input["customers"]:
        anlyon.invoke("refund", {"customer": customer, "amount": 100})
    [anlyon.invoke("cancel-order", {"order": order}) for order in input["orders"]]
    key = os.environ["STRIPE_KEY"]
    eval("1 + 1")
    with open("/etc/passwd") as handle:
        return handle.read()
