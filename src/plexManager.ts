import { createHash } from 'crypto';
import Fuse from 'fuse.js';
import { Logger } from './logger.js';
import { TTLCache } from './cache.js';
import {
  checkAuthPin,
  connectToServer,
  createAuthPin,
  fetchServerUsers,
  getResources,
  validateToken,
  buildAuthUrl,
} from './plexClient.js';
import type { PlexPin, PlexPinStatus } from './plexClient.js';
import type { ConfigAccount, PlexServer, PlexUserAccess } from './types.js';

export interface ManagerOptions {
  cacheTtlMs: number;
}

export interface SearchOptions {
  maxResults?: number;
  refresh?: boolean;
}

export interface SearchResult {
  matches: Array<{
    score: number;
    user: PlexUserAccess;
    matchDetails: Array<Record<string, unknown>>;
  }>;
  totalMatched: number;
  totalSearched: number;
}

export interface AccountValidationResult {
  label: string;
  valid: boolean;
  username?: string;
  email?: string;
}

export interface AuthPinResult {
  pin: PlexPin;
  authorizationUrl: string;
}

function deterministicIdentifier(label: string): string {
  const hash = createHash('sha1').update(label).digest('hex');
  return hash.slice(0, 32);
}

export class PlexAccountManager {
  private readonly accounts: Array<ConfigAccount & { clientIdentifier: string }>;
  private readonly logger: Logger;
  private readonly serverCache: TTLCache<string, PlexServer[]>;
  private readonly userCache: TTLCache<string, PlexUserAccess[]>;

  constructor(accounts: ConfigAccount[], options: ManagerOptions, logger: Logger) {
    this.logger = logger.child('manager');
    this.accounts = accounts.map((account) => ({
      ...account,
      clientIdentifier: account.clientIdentifier ?? deterministicIdentifier(account.label),
    }));
    this.serverCache = new TTLCache<string, PlexServer[]>(options.cacheTtlMs);
    this.userCache = new TTLCache<string, PlexUserAccess[]>(options.cacheTtlMs);
  }

  getAccountCount(): number {
    return this.accounts.length;
  }

  async validateAccounts(): Promise<AccountValidationResult[]> {
    const results: AccountValidationResult[] = [];
    for (const account of this.accounts) {
      const info = await validateToken(account.token, this.logger.child('validate'), account.clientIdentifier);
      if (info) {
        results.push({
          label: account.label,
          valid: true,
          username: info.username,
          email: info.email,
        });
      } else {
        results.push({ label: account.label, valid: false });
      }
    }
    return results;
  }

  async getServers(refresh = false): Promise<PlexServer[]> {
    const aggregated: PlexServer[] = [];
    const seen = new Set<string>();

    for (const account of this.accounts) {
      const cacheKey = `servers:${account.label}`;
      let servers = this.serverCache.get(cacheKey);
      if (!servers || refresh) {
        this.logger.info('Loading servers for account', { label: account.label });
        const resources = await getResources(account.token, this.logger.child('resources'), account.clientIdentifier);
        const connected: PlexServer[] = [];
        for (const resource of resources) {
          const server = await connectToServer(
            resource,
            account.token,
            account.label,
            this.logger.child('connect'),
            account.clientIdentifier
          );
          if (server) {
            connected.push(server);
          }
        }
        servers = connected;
        this.serverCache.set(cacheKey, servers);
      }

      for (const server of servers) {
        const key = `${server.machineIdentifier}:${account.label}`;
        if (!seen.has(key)) {
          seen.add(key);
          aggregated.push(server);
        }
      }
    }

    return aggregated;
  }

  async getUsersAcrossServers(refresh = false): Promise<PlexUserAccess[]> {
    const servers = await this.getServers(refresh);
    const users: PlexUserAccess[] = [];

    for (const server of servers) {
      const cacheKey = `users:${server.machineIdentifier}:${server.accountLabel}`;
      let cached = this.userCache.get(cacheKey);
      if (!cached || refresh) {
        this.logger.info('Fetching users for server', {
          server: server.friendlyName,
          account: server.accountLabel,
        });
        cached = await fetchServerUsers(
          server,
          this.findTokenForAccount(server.accountLabel),
          this.logger.child('users'),
          this.findClientIdentifier(server.accountLabel)
        );
        this.userCache.set(cacheKey, cached);
      }

      users.push(...cached);
    }

    return users;
  }

  async searchUsers(query: string, options: SearchOptions = {}): Promise<SearchResult> {
    const trimmed = query.trim();
    if (!trimmed) {
      return { matches: [], totalMatched: 0, totalSearched: 0 };
    }

    const users = await this.getUsersAcrossServers(Boolean(options.refresh));
    if (users.length === 0) {
      return { matches: [], totalMatched: 0, totalSearched: 0 };
    }

    const fuse = new Fuse(users, {
      includeScore: true,
      includeMatches: true,
      threshold: 0.4,
      ignoreLocation: true,
      keys: [
        { name: 'email', weight: 0.5 },
        { name: 'username', weight: 0.3 },
        { name: 'title', weight: 0.2 },
      ],
    });

    const results = fuse.search(trimmed, { limit: options.maxResults ?? 25 });

    return {
      matches: results.map((res) => ({
        score: res.score ?? 1,
        user: res.item,
        matchDetails: (res.matches ?? []).map((match) => ({
          key: match.key,
          value: match.value,
          indices: match.indices,
        })),
      })),
      totalMatched: results.length,
      totalSearched: users.length,
    };
  }

  async generateAuthPin(clientIdentifier?: string): Promise<AuthPinResult> {
    const pin = await createAuthPin(clientIdentifier, this.logger.child('auth'));
    return {
      pin,
      authorizationUrl: buildAuthUrl(pin),
    };
  }

  async checkAuthPinStatus(id: number, clientIdentifier: string): Promise<PlexPinStatus> {
    return checkAuthPin(id, clientIdentifier, this.logger.child('auth'));
  }

  clearCaches(): void {
    this.serverCache.clear();
    this.userCache.clear();
  }

  private findTokenForAccount(label: string): string {
    const account = this.accounts.find((acct) => acct.label === label);
    if (!account) {
      throw new Error(`No account found for label ${label}`);
    }
    return account.token;
  }

  private findClientIdentifier(label: string): string {
    const account = this.accounts.find((acct) => acct.label === label);
    if (!account) {
      throw new Error(`No account found for label ${label}`);
    }
    return account.clientIdentifier;
  }
}
