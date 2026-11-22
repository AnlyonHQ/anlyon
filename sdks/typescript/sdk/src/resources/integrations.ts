import { BaseResource } from './base';
import type { HttpClient } from '../core/http-client';
import type { ApiResponse, SimpleMessage } from '../types/api';

export interface Integration {
  id: string;
  type: 'slack' | 'discord';
  name: string;
  isActive: boolean;
  enabledEventTypes: string[];
  lastUsedAt: string | null;
  lastError: string | null;
  errorCount: number;
  createdAt: string;
  slackTeamId: string | null;
  slackTeamName: string | null;
  slackChannelId: string | null;
  slackChannelName: string | null;
  discordServerId: string | null;
  discordChannelName: string | null;
}
export interface DiscordIntegrationCreated {
  id: string; type: 'discord'; name: string; isActive: boolean; enabledEventTypes: string[];
  discordChannelName: string | null; createdAt: string;
}
export interface SlackChannel { id: string; name: string; isPrivate: boolean | null; isMember: boolean | null }
export interface SlackChannelUpdateResult {
  message: string; channelId: string; channelName: string; autoJoined: boolean;
  isPrivate: boolean | null; joinError: string | null;
}

export class IntegrationsResource extends BaseResource {
  constructor(http: HttpClient) { super(http, '/api/v2/integrations'); }
  list(): Promise<ApiResponse<Integration[]>> { return this._get(); }
  createDiscord(input: { name: string; webhookUrl: string; enabledEventTypes?: string[] }): Promise<ApiResponse<DiscordIntegrationCreated>> { return this._post('/discord', input); }
  testDiscord(id: string): Promise<ApiResponse<SimpleMessage>> { return this._post(`/discord/${id}/test`); }
  listSlackChannels(id: string): Promise<ApiResponse<SlackChannel[]>> { return this._get(`/slack/${id}/channels`); }
  updateSlackChannel(id: string, input: { channelId: string; channelName: string }): Promise<ApiResponse<SlackChannelUpdateResult>> { return this._patch(`/slack/${id}/channel`, input); }
  testSlack(id: string): Promise<ApiResponse<SimpleMessage>> { return this._post(`/slack/${id}/test`); }
  delete(id: string): Promise<ApiResponse<SimpleMessage>> { return this._delete(`/${id}`); }
  toggle(id: string, isActive: boolean): Promise<ApiResponse<{ message: string; isActive: boolean }>> { return this._patch(`/${id}/toggle`, { isActive }); }
  updateEventTypes(id: string, enabledEventTypes: string[]): Promise<ApiResponse<{ message: string; enabledEventTypes: string[] }>> { return this._patch(`/${id}/events`, { enabledEventTypes }); }
}
