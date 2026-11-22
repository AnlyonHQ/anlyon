/**
 * Events MCP tools  publish, list/get, topics, and subscriptions.
 */

import { ADDITIVE, DELETES, READ_ONLY, type McpTool } from './types.ts';

export const eventsTools: McpTool[] = [
  {
    name: 'publish_event',
    annotations: { ...ADDITIVE, openWorldHint: true },
    scopes: ['anlyon:messaging'],
    description:
      'Publish an event to a topic. Fan-out to subscriptions is asynchronous. Use idempotencyKey to dedupe retries.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'Topic name or public id (top_xxx).',
        },
        type: {
          type: 'string',
          description: 'Dot-segmented event type (e.g. "order.created").',
        },
        data: {
          type: 'object',
          additionalProperties: true,
          description: 'Arbitrary event payload.',
        },
        idempotencyKey: {
          type: 'string',
          description: 'Optional idempotency key for deduplication.',
        },
      },
      required: ['topic', 'type'],
    },
    handler: async (client, args) => {
      const { data } = await client.events.publish({
        topic: args.topic as string,
        type: args.type as string,
        data: args.data as Record<string, unknown> | undefined,
        idempotencyKey: args.idempotencyKey as string | undefined,
      });
      return data;
    },
  },
  {
    name: 'list_events',
    annotations: READ_ONLY,
    scopes: ['anlyon:messaging'],
    description: 'List published events with optional topic/type filters. Paginated.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Filter by topic name or id.' },
        type: { type: 'string', description: 'Filter by event type.' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Page size (default 20).',
        },
        offset: {
          type: 'integer',
          minimum: 0,
          description: 'Skip count for pagination.',
        },
      },
    },
    handler: async (client, args) => {
      const { data } = await client.events.list({
        topic: args.topic as string | undefined,
        type: args.type as string | undefined,
        limit: args.limit as number | undefined,
        offset: args.offset as number | undefined,
      });
      return data;
    },
  },
  {
    name: 'get_event',
    annotations: READ_ONLY,
    scopes: ['anlyon:messaging'],
    description: 'Get a single event with per-subscription delivery statuses.',
    inputSchema: {
      type: 'object',
      properties: {
        eventId: { type: 'string', description: 'Public event id (evt_xxx).' },
      },
      required: ['eventId'],
    },
    handler: async (client, args) => {
      const { data } = await client.events.get(args.eventId as string);
      return data;
    },
  },
  {
    name: 'create_topic',
    annotations: ADDITIVE,
    scopes: ['anlyon:messaging'],
    description: 'Create an event topic to namespace publishes and subscriptions.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Topic name (alphanumeric, hyphens, underscores).',
        },
        description: { type: 'string', description: 'Optional description.' },
      },
      required: ['name'],
    },
    handler: async (client, args) => {
      const { data } = await client.events.createTopic({
        name: args.name as string,
        description: args.description as string | undefined,
      });
      return data;
    },
  },
  {
    name: 'list_topics',
    annotations: READ_ONLY,
    scopes: ['anlyon:messaging'],
    description: 'List all event topics in the workspace.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async (client) => {
      const { data } = await client.events.listTopics();
      return data;
    },
  },
  {
    name: 'delete_topic',
    annotations: DELETES,
    scopes: ['anlyon:messaging'],
    description:
      'Delete a topic by id or name. Cascades subscriptions and events. Reserved platform topics cannot be deleted.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'Topic public id (top_xxx) or name.',
        },
      },
      required: ['ref'],
    },
    handler: async (client, args) => {
      const { data } = await client.events.deleteTopic(args.ref as string);
      return data;
    },
  },
  {
    name: 'create_subscription',
    annotations: { ...ADDITIVE, openWorldHint: true },
    scopes: ['anlyon:messaging'],
    description:
      'Subscribe a webhook URL to a topic. With generateSecret true, the plaintext secret is returned once. Save it immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        topicRef: {
          type: 'string',
          description: 'Topic public id (top_xxx) or name.',
        },
        url: {
          type: 'string',
          format: 'uri',
          description: 'Webhook URL to deliver matching events to.',
        },
        eventTypes: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 50,
          description: 'Event type patterns ("*", "order.*", or exact). Defaults to ["*"].',
        },
        enabled: {
          type: 'boolean',
          description: 'Whether the subscription is active (default true).',
        },
        generateSecret: {
          type: 'boolean',
          description: 'Generate a per-subscription signing secret (returned once).',
        },
        headers: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Extra headers to attach on delivery.',
        },
      },
      required: ['topicRef', 'url'],
    },
    handler: async (client, args) => {
      const { data } = await client.events.createSubscription(args.topicRef as string, {
        url: args.url as string,
        eventTypes: args.eventTypes as string[] | undefined,
        enabled: args.enabled as boolean | undefined,
        generateSecret: args.generateSecret as boolean | undefined,
        headers: args.headers as Record<string, string> | undefined,
      });
      return data;
    },
  },
  {
    name: 'list_subscriptions',
    annotations: READ_ONLY,
    scopes: ['anlyon:messaging'],
    description: 'List webhook subscriptions for a topic.',
    inputSchema: {
      type: 'object',
      properties: {
        topicRef: {
          type: 'string',
          description: 'Topic public id (top_xxx) or name.',
        },
      },
      required: ['topicRef'],
    },
    handler: async (client, args) => {
      const { data } = await client.events.listSubscriptions(args.topicRef as string);
      return data;
    },
  },
  {
    name: 'delete_subscription',
    annotations: DELETES,
    scopes: ['anlyon:messaging'],
    description: 'Delete a webhook subscription by id.',
    inputSchema: {
      type: 'object',
      properties: {
        subscriptionId: {
          type: 'string',
          description: 'Public subscription id (sub_xxx).',
        },
      },
      required: ['subscriptionId'],
    },
    handler: async (client, args) => {
      const { data } = await client.events.deleteSubscription(
        args.subscriptionId as string
      );
      return data;
    },
  },
];
