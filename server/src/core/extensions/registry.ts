import type { Hono } from "hono";
import { mountModule } from "../../api/mount-module.ts";
import { createLogger } from "../../lib/logger.ts";
import { resetProductEventSink, setProductEventSink, type ProductEventSink } from "../../lib/product-events.ts";
import { resetWorkAdmission, setWorkAdmission, type WorkAdmission } from "../billing/work-admission.ts";
import { currentEdition, type Edition } from "../edition/edition.ts";
import { defineModule, isModuleEnabled, resetDefinedModules, type ModuleDefinition, type ModuleId } from "../edition/modules.ts";
import { resetPlanProvider, setPlanProvider, type PlanProvider } from "../plans/limits.ts";
import { addPartitionedLog, resetPartitionedLogs, type PartitionedLogSpec } from "../archival/partitioned-logs.ts";
import { addKnownVendor, resetAddedVendors, type KnownVendor } from "../connections/known-vendors.ts";
import { resetRetiredOAuthScopes, retireOAuthScopes } from "../auth/oauth-unknown-scopes.ts";

const logger = createLogger({ module: "extensions" });

// biome-ignore lint/suspicious/noExplicitAny: Hono's generic parameters differ per router.
type AnyHono = Hono<any, any, any>;

export interface MaintenanceSweep {
  name: string;
  context: string;
  intervalMs: number;
  enabled?: () => boolean;
  module?: ModuleId;
  run: () => Promise<void>;
}

export interface StartTask {
  name: string;
  module?: ModuleId;
  run: () => Promise<void> | void;
}

export interface StopTask {
  name: string;
  run: () => void;
}

export interface ExtensionApi {
  readonly name: string;
  readonly edition: Edition;
  modules: {
    define(id: string, definition: ModuleDefinition): void;
  };
  routes: {
    mount(module: ModuleId, path: string, router: AnyHono): void;
  };
  sweeps: {
    add(sweep: MaintenanceSweep): void;
  };
  lifecycle: {
    onStart(task: StartTask): void;
    onStop(task: StopTask): void;
  };
  plans: {
    provide(provider: PlanProvider): void;
  };
  productEvents: {
    provide(sink: ProductEventSink): void;
  };
  workAdmission: {
    provide(brake: WorkAdmission): void;
  };
  logPartitions: {
    add(spec: PartitionedLogSpec): void;
  };
  vendors: {
    add(vendor: KnownVendor): void;
  };
  oauth: {
    retireScopes(scopes: readonly string[]): void;
  };
}

export interface ServerExtension {
  name: string;
  register(api: ExtensionApi): void | Promise<void>;
}

interface RouteMount {
  extension: string;
  module: ModuleId;
  path: string;
  router: AnyHono;
}

const registered = new Map<string, Promise<void>>();
const routeMounts: RouteMount[] = [];
const sweeps: MaintenanceSweep[] = [];
const startTasks: StartTask[] = [];
const stopTasks: StopTask[] = [];
let boundApp: AnyHono | null = null;

function mount(entry: RouteMount): void {
  if (!boundApp) return;
  mountModule(boundApp, entry.module, entry.path, entry.router);
}

function apiFor(name: string): ExtensionApi {
  return {
    name,
    edition: currentEdition(),
    modules: { define: (id, definition) => defineModule(id, definition) },
    routes: {
      mount: (module, path, router) => {
        const entry = { extension: name, module, path, router };
        routeMounts.push(entry);
        mount(entry);
      },
    },
    sweeps: { add: (sweep) => void sweeps.push(sweep) },
    lifecycle: {
      onStart: (task) => void startTasks.push(task),
      onStop: (task) => void stopTasks.push(task),
    },
    plans: { provide: (provider) => setPlanProvider(provider) },
    productEvents: { provide: (sink) => setProductEventSink(sink) },
    workAdmission: { provide: (brake) => setWorkAdmission(brake) },
    logPartitions: { add: (spec) => addPartitionedLog(spec) },
    vendors: { add: (vendor) => addKnownVendor(vendor) },
    oauth: { retireScopes: (scopes) => retireOAuthScopes(scopes) },
  };
}

export function registerExtension(extension: ServerExtension): Promise<void> {
  const existing = registered.get(extension.name);
  if (existing) return existing;
  const done = (async () => {
    await extension.register(apiFor(extension.name));
    logger.debug({ extension: extension.name }, "Extension registered");
  })();
  registered.set(extension.name, done);
  return done;
}

export function registeredExtensions(): string[] {
  return [...registered.keys()];
}

export function bindExtensionRoutes(app: AnyHono): void {
  if (boundApp === app) return;
  if (boundApp) throw new Error("Extension routes are already bound to another app");
  boundApp = app;
  for (const entry of routeMounts) mount(entry);
}

export function extensionSweeps(): readonly MaintenanceSweep[] {
  return sweeps;
}

export function enabledStartTasks(): StartTask[] {
  return startTasks.filter((task) => !task.module || isModuleEnabled(task.module));
}

export async function runStartTasks(): Promise<void> {
  for (const task of enabledStartTasks()) await task.run();
}

export function runStopTasks(): void {
  for (const task of stopTasks) {
    try {
      task.run();
    } catch (error) {
      logger.warn({ error, task: task.name }, "Extension stop task failed");
    }
  }
}

export function resetExtensions(): void {
  registered.clear();
  routeMounts.length = 0;
  sweeps.length = 0;
  startTasks.length = 0;
  stopTasks.length = 0;
  boundApp = null;
  resetDefinedModules();
  resetPlanProvider();
  resetProductEventSink();
  resetWorkAdmission();
  resetPartitionedLogs();
  resetAddedVendors();
  resetRetiredOAuthScopes();
}
