// Refund an order after checking it was paid, then tell the customer.
export default async function run(input, api) {
  const order = await api.read("lookup-order", { id: input.order });
  if (!order.ok || order.result.status !== "paid") return { refunded: false };
  const refund = await api.invoke("refund", { order: input.order, amount: input.amount });
  await api.invoke(`send-email`, { to: order.result.email, template: "refunded" });
  return { refunded: refund.ok };
}
