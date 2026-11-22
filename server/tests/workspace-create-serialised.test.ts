import { beforeEach, describe, expect, it, vi } from "vitest";

const lock = vi.hoisted(() => ({ withLock: vi.fn() }));
vi.mock("../src/lib/distributed-lock.ts", () => lock);
vi.mock("../src/db/index.ts", () => ({ db: {} }));
vi.mock("../src/lib/logger.ts", () => {
  const l = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  return { logger: l, createLogger: () => l };
});
vi.mock("../src/utils/slug.ts", () => ({ generateUniqueSlug: vi.fn(), generateSlug: vi.fn() }));
vi.mock("../src/core/environments/service.ts", () => ({ ensureDefaultEnvironment: vi.fn() }));
vi.mock("../src/core/notifications/notification-service.ts", () => ({ initializeNotificationPreferences: vi.fn() }));
vi.mock("../src/lib/product-events.ts", () => ({ capture: vi.fn() }));
vi.mock("../src/core/auth/api-keys.ts", () => ({ createApiKey: vi.fn() }));
vi.mock("../src/core/auth/delivery-secrets.ts", () => ({ createDeliverySecret: vi.fn() }));

import { createWorkspace } from "../src/core/workspace/service.ts";

beforeEach(() => vi.clearAllMocks());

describe("createWorkspace serialisation", () => {
  it("takes a per-user lock, so the one-workspace cap cannot be raced with concurrent requests", async () => {
    lock.withLock.mockResolvedValue({ id: "ws-1" });
    await expect(createWorkspace("user-1", { name: "Acme" } as never)).resolves.toEqual({ id: "ws-1" });
    expect(lock.withLock.mock.calls[0][0]).toBe("workspace-create:user-1");
    await createWorkspace("user-2", { name: "Other" } as never);
    expect(lock.withLock.mock.calls[1][0]).toBe("workspace-create:user-2");
  });

  it("refuses rather than creating a second workspace when the lock cannot be taken", async () => {
    lock.withLock.mockResolvedValue(null);
    await expect(createWorkspace("user-1", { name: "Acme" } as never)).rejects.toMatchObject({ statusCode: 409 });
  });
});
