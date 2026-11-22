import { CHECKED_ON, publicVendors, SOURCE_URL } from "@anlyon/known-vendors";
import { Hono } from "hono";
import { knownVendors } from "../../core/connections/known-vendors.ts";

const mcpVendorsRouter = new Hono({ strict: false });

mcpVendorsRouter.get("/", (c) => {
  c.header("Cache-Control", "public, max-age=300, s-maxage=300");
  return c.json({
    success: true,
    data: { checkedOn: CHECKED_ON, source: SOURCE_URL, vendors: publicVendors(knownVendors()) },
  });
});

export default mcpVendorsRouter;
