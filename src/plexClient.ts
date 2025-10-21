import axios from 'axios';
import type { AxiosRequestConfig } from 'axios';
import { parseStringPromise } from 'xml2js';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from './logger.js';
import type { PlexResource, PlexServer, PlexUserAccess } from './types.js';

const PLEX_API_BASE = 'https://plex.tv';
const PLEX_PRODUCT = 'Plex MCP Account Finder';
const PLEX_VERSION = '0.1.0';
const PLEX_PLATFORM = 'Node';
const PLEX_DEVICE = 'MCP';
const DEFAULT_TIMEOUT_MS = 15000;

interface RequestOptions {
  token?: string;
  clientIdentifier?: string;
  timeoutMs?: number;
  responseType?: AxiosRequestConfig['responseType'];
}

function buildHeaders(options: RequestOptions = {}): Record<string, string> {
  const identifier = options.clientIdentifier ?? uuidv4();

  const headers: Record<string, string> = {
    'X-Plex-Product': PLEX_PRODUCT,
    'X-Plex-Version': PLEX_VERSION,
    'X-Plex-Platform': PLEX_PLATFORM,
    'X-Plex-Device': PLEX_DEVICE,
    'X-Plex-Client-Identifier': identifier,
    Accept: 'application/json',
  };

  if (options.token) {
    headers['X-Plex-Token'] = options.token;
  }

  return headers;
}

function createRequestOptions(
  token?: string,
  clientIdentifier?: string,
  extras: Partial<RequestOptions> = {}
): RequestOptions {
  const options: RequestOptions = { ...extras };
  if (token) {
    options.token = token;
  }
  if (clientIdentifier) {
    options.clientIdentifier = clientIdentifier;
  }
  return options;
}

async function request<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const headers = buildHeaders(options);
  const config: AxiosRequestConfig = {
    headers,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };

  if (options.responseType) {
    config.responseType = options.responseType;
  }

  const response = await axios.get(url, config);
  return response.data as T;
}

export async function validateToken(
  token: string,
  logger: Logger,
  clientIdentifier?: string
): Promise<{ username: string; email: string } | null> {
  try {
    const data = await request<any>(
      `${PLEX_API_BASE}/users/account.json`,
      createRequestOptions(token, clientIdentifier)
    );
    const user = data?.user;
    if (!user) {
      return null;
    }
    return {
      username: user.username || user.title,
      email: user.email,
    };
  } catch (error) {
    logger.warn('Token validation failed', {
      error_message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function getResources(
  token: string,
  logger: Logger,
  clientIdentifier?: string
): Promise<PlexResource[]> {
  try {
    const xml = await request<string>(
      `${PLEX_API_BASE}/pms/resources`,
      createRequestOptions(token, clientIdentifier, { responseType: 'text' })
    );

    const parsed = await parseStringPromise(xml);
    const devices = parsed?.MediaContainer?.Device ?? [];
    return devices
      .filter((device: any) => device.$?.product === 'Plex Media Server')
      .map((device: any) => {
        const attrs = device.$ ?? {};
        return {
          name: attrs.name,
          provides: attrs.provides,
          machineIdentifier: attrs.clientIdentifier,
          owned: attrs.owned === '1',
          product: attrs.product,
          version: attrs.productVersion,
          platform: attrs.platform,
          uri: attrs.uri || '',
          connections: (device.Connection || []).map((conn: any) => ({
            protocol: conn.$?.protocol,
            address: conn.$?.address,
            port: parseInt(conn.$?.port ?? '0', 10),
            uri: conn.$?.uri,
          })),
        } satisfies PlexResource;
      });
  } catch (error) {
    logger.error('Failed to fetch Plex resources', {
      error_message: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

export async function connectToServer(
  resource: PlexResource,
  token: string,
  accountLabel: string,
  logger: Logger,
  clientIdentifier?: string
): Promise<PlexServer | null> {
  for (const connection of resource.connections) {
    if (!connection?.uri) {
      continue;
    }
    try {
      const data = await request<any>(
        connection.uri,
        createRequestOptions(token, clientIdentifier, { timeoutMs: 5000 })
      );
      if (data?.MediaContainer) {
        return {
          name: resource.name,
          friendlyName: data.MediaContainer.friendlyName || resource.name,
          machineIdentifier: resource.machineIdentifier,
          host: connection.address,
          port: connection.port,
          scheme: connection.protocol,
          uri: connection.uri,
          product: resource.product,
          version: resource.version,
          platform: resource.platform,
          owned: resource.owned,
          accountLabel,
        } satisfies PlexServer;
      }
    } catch (error) {
      logger.debug('Server connection attempt failed', {
        server_uri: connection.uri,
        error_message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  logger.warn('Unable to connect to Plex server resource', {
    machineIdentifier: resource.machineIdentifier,
    resource_name: resource.name,
  });
  return null;
}

function normalizeBoolean(value: unknown): boolean | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value === 1;
  }
  if (typeof value === 'string') {
    return value === '1' || value.toLowerCase() === 'true';
  }
  return null;
}

function mapAccountNode(node: any, server: PlexServer, accountLabel: string): PlexUserAccess {
  const attrs = node.$ ?? node ?? {};
  const email = attrs.email ?? attrs.Email;
  return {
    id: attrs.id ? Number(attrs.id) : null,
    uuid: attrs.uuid ?? attrs.UUID ?? null,
    username: attrs.username ?? attrs.name ?? null,
    title: attrs.title ?? attrs.friendlyName ?? null,
    email: email ?? null,
    restricted: normalizeBoolean(attrs.restricted),
    home: normalizeBoolean(attrs.home),
    guest: normalizeBoolean(attrs.guest),
    canInvite: normalizeBoolean(attrs.canInvite),
    serverIdentifier: server.machineIdentifier,
    serverName: server.friendlyName,
    accountLabel,
  } satisfies PlexUserAccess;
}

export async function fetchServerUsers(
  server: PlexServer,
  token: string,
  logger: Logger,
  clientIdentifier?: string
): Promise<PlexUserAccess[]> {
  const results: PlexUserAccess[] = [];

  try {
    const data = await request<any>(
      `${server.uri}/accounts`,
      createRequestOptions(token, clientIdentifier)
    );
    const accounts = data?.MediaContainer?.Account ?? [];
    if (Array.isArray(accounts) && accounts.length > 0) {
      for (const account of accounts) {
        results.push(mapAccountNode(account, server, server.accountLabel));
      }
    }
  } catch (error) {
    logger.debug('Local accounts endpoint failed', {
      server: server.friendlyName,
      error_message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const xml = await request<string>(
      `${PLEX_API_BASE}/api/servers/${server.machineIdentifier}/shared_servers`,
      createRequestOptions(token, clientIdentifier, { responseType: 'text' })
    );
    const parsed = await parseStringPromise(xml);
    const sharedServers = parsed?.MediaContainer?.SharedServer ?? [];
    for (const entry of sharedServers) {
      const sharedUsers = entry?.SharedUser ?? [];
      if (Array.isArray(sharedUsers) && sharedUsers.length > 0) {
        for (const sharedUser of sharedUsers) {
          results.push(mapAccountNode(sharedUser, server, server.accountLabel));
        }
      } else {
        results.push(mapAccountNode(entry, server, server.accountLabel));
      }
    }
  } catch (error) {
    logger.debug('Shared server endpoint failed', {
      server: server.friendlyName,
      error_message: error instanceof Error ? error.message : String(error),
    });
  }

  const deduped = new Map<string, PlexUserAccess>();
  for (const user of results) {
    const keySource =
      user.email ??
      user.uuid ??
      (user.username ? `${user.serverIdentifier}-${user.username}` : `${user.serverIdentifier}-${user.id ?? 'unknown'}`);
    const key = keySource.toLowerCase();
    if (!deduped.has(key)) {
      deduped.set(key, user);
    }
  }

  return Array.from(deduped.values());
}

export interface PlexPin {
  id: number;
  code: string;
  clientIdentifier: string;
  expiresAt: string;
  authToken: string | null;
}

export async function createAuthPin(clientIdentifier?: string, logger?: Logger): Promise<PlexPin> {
  const identifier = clientIdentifier ?? uuidv4();
  try {
    const response = await axios.post(
      `${PLEX_API_BASE}/api/v2/pins`,
      new URLSearchParams({ strong: 'true' }),
      {
        headers: {
          ...buildHeaders({ clientIdentifier: identifier }),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: DEFAULT_TIMEOUT_MS,
      }
    );

    const pin = response.data?.pin;
    return {
      id: pin.id,
      code: pin.code,
      clientIdentifier: identifier,
      expiresAt: pin.expiresAt,
      authToken: pin.authToken ?? null,
    } satisfies PlexPin;
  } catch (error) {
    logger?.error('Failed to create Plex auth PIN', {
      error_message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export interface PlexPinStatus {
  id: number;
  code: string;
  clientIdentifier: string;
  expiresAt: string;
  authToken: string | null;
}

export async function checkAuthPin(
  id: number,
  clientIdentifier: string,
  logger?: Logger
): Promise<PlexPinStatus> {
  try {
    const response = await axios.get(`${PLEX_API_BASE}/api/v2/pins/${id}`, {
      headers: buildHeaders({ clientIdentifier }),
      timeout: DEFAULT_TIMEOUT_MS,
    });
    const pin = response.data?.pin;
    return {
      id: pin.id,
      code: pin.code,
      clientIdentifier,
      expiresAt: pin.expiresAt,
      authToken: pin.authToken ?? null,
    } satisfies PlexPinStatus;
  } catch (error) {
    logger?.error('Failed to fetch Plex auth PIN status', {
      pin_id: id,
      error_message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export function buildAuthUrl(pin: PlexPin, productName: string = PLEX_PRODUCT): string {
  const url = new URL('https://app.plex.tv/auth');
  url.hash = new URLSearchParams({
    clientID: pin.clientIdentifier,
    code: pin.code,
    'context[device][product]': productName,
    'context[device][environment]': 'bundled',
    'context[device][platform]': 'Web',
    'context[device][device]': PLEX_DEVICE,
    'context[device][model]': 'MCP',
    'context[device][version]': PLEX_VERSION,
    'context[client][product]': productName,
    'context[client][version]': PLEX_VERSION,
    'context[client][device]': PLEX_DEVICE,
    'context[client][platform]': 'Web',
    'context[client][model]': 'MCP',
  }).toString();
  return url.toString();
}
