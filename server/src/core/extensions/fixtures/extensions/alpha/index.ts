import { Hono } from "hono";
import type { ServerExtension } from "../../../registry.ts";

const router = new Hono();
router.get("/", (c) => c.text("alpha"));

const alpha: ServerExtension = {
  name: "alpha",
  register(api) {
    api.modules.define("alpha-module", { kind: "cloud", editions: ["cloud", "community", "team", "enterprise"], paths: ["/api/v2/alpha/*"], summary: "Test module." });
    api.routes.mount("alpha-module", "/api/v2/alpha", router);
  },
};

export default alpha;
