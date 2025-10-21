import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Logger } from './logger.js';
import type { LogLevel } from './logger.js';
import { PlexAccountManager } from './plexManager.js';
import type { ConfigAccount } from './types.js';

const logLevelEnum = z.enum(['debug', 'info', 'warn', 'error']);

export const configSchema = z.object({
  log_level: logLevelEnum.default('info'),
  cache_ttl_seconds: z.number().int().min(30).max(3600).default(300),
  accounts: z
    .array(
      z.object({
        label: z.string().min(1, 'Account label is required'),
        token: z.string().min(1, 'Plex API token is required'),
        client_identifier: z.string().optional(),
      })
    )
    .default([]),
});

type ServerConfig = z.infer<typeof configSchema>;

const lookupShape = {
  query: z.string().min(1, 'Search query is required').describe('Email, username, or partial name to search for.'),
  max_results: z.number().int().min(1).max(50).optional().describe('Max number of matches to return (default 25).'),
  refresh: z.boolean().optional().describe('When true, bypass caches and fetch fresh data from Plex.'),
};
const lookupSchema = z.object(lookupShape);
type LookupInput = z.infer<typeof lookupSchema>;

const statusShape = {
  refresh: z.boolean().optional().describe('When true, refresh cached server and user data.'),
  include_user_count: z.boolean().optional().describe('When true, count distinct users across servers.'),
};
const statusSchema = z.object(statusShape);
type StatusInput = z.infer<typeof statusSchema>;

const authUrlShape = {
  client_identifier: z
    .string()
    .optional()
    .describe('Optional Plex client identifier to associate with the login request. If omitted, a random identifier is generated.'),
};
const authUrlSchema = z.object(authUrlShape);
type AuthUrlInput = z.infer<typeof authUrlSchema>;

const pollShape = {
  pin_id: z.number().int().describe('Numeric Plex PIN identifier returned by plex_generate_auth_url.'),
  client_identifier: z.string().describe('Client identifier returned alongside the authorization URL.'),
};
const pollSchema = z.object(pollShape);
type PollInput = z.infer<typeof pollSchema>;

export default function createServer({
  config,
}: {
  config: ServerConfig;
}) {
  const accountConfigs: ConfigAccount[] = config.accounts.map((acct) => {
    const base: ConfigAccount = {
      label: acct.label,
      token: acct.token,
    };
    if (acct.client_identifier) {
      base.clientIdentifier = acct.client_identifier;
    }
    return base;
  });

  const logger = new Logger(config.log_level as LogLevel, 'plex-mcp');
  logger.info('Starting Plex MCP Account Finder', {
    accounts: accountConfigs.length,
    cache_ttl_seconds: config.cache_ttl_seconds,
    log_level: config.log_level,
  });

  if (accountConfigs.length === 0) {
    logger.warn('No Plex accounts configured. Tools will operate in read-only/degraded mode until tokens are provided.');
  }

  const manager = new PlexAccountManager(
    accountConfigs,
    { cacheTtlMs: config.cache_ttl_seconds * 1000 },
    logger
  );

  const server = new McpServer({
    name: 'plex-account-finder',
    version: '0.1.0',
  });

  registerTools(server, manager, logger);

  return server.server;
}

function registerTools(server: McpServer, manager: PlexAccountManager, logger: Logger) {
  const toolsLogger = logger.child('tools');

  server.registerTool(
    'plex_status',
    {
      title: 'Plex Server Status',
      description: 'Validates configured Plex accounts and summarizes server availability.',
      inputSchema: statusShape,
    },
    async (input: StatusInput) => {
      toolsLogger.info('Status tool invoked', input ?? {});
      const validation = await manager.validateAccounts();
      const servers = await manager.getServers(Boolean(input?.refresh));

      let userCount: number | undefined;
      if (input?.include_user_count) {
        const users = await manager.getUsersAcrossServers(Boolean(input?.refresh));
        userCount = users.length;
      }

      const summaryLines: string[] = [
        `Accounts configured: ${manager.getAccountCount()}`,
        `Servers discovered: ${servers.length}`,
        `Accounts valid: ${validation.filter((v) => v.valid).length}/${validation.length}`,
      ];

      if (typeof userCount === 'number') {
        summaryLines.push(`Distinct users found: ${userCount}`);
      }

      return {
        content: [
          {
            type: 'text',
            text: summaryLines.join('\n'),
          },
        ],
        structuredContent: {
          status: 'ok',
          server_time: new Date().toISOString(),
          accounts: validation,
          servers: servers.map((server) => ({
            name: server.friendlyName,
            machineIdentifier: server.machineIdentifier,
            product: server.product,
            version: server.version,
            platform: server.platform,
            accountLabel: server.accountLabel,
            owned: server.owned,
          })),
          user_count: userCount,
        } as Record<string, unknown>,
      };
    }
  );

  server.registerTool(
    'plex_lookup_user',
    {
      title: 'Plex User Lookup',
      description: 'Search for Plex user access across all configured servers using fuzzy matching.',
      inputSchema: lookupShape,
    },
    async (input: LookupInput) => {
      toolsLogger.info('Lookup tool invoked', {
        query: input.query,
        max_results: input.max_results,
        refresh: input.refresh,
      });

      const searchOptions: { maxResults?: number; refresh?: boolean } = {};
      if (typeof input.max_results === 'number') {
        searchOptions.maxResults = input.max_results;
      }
      if (typeof input.refresh === 'boolean') {
        searchOptions.refresh = input.refresh;
      }

      const result = await manager.searchUsers(input.query, searchOptions);

      return {
        content: [
          {
            type: 'text',
            text: formatLookupSummary(result),
          },
        ],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }
  );

  server.registerTool(
    'plex_generate_auth_url',
    {
      title: 'Generate Plex Authorization URL',
      description: 'Creates a Plex authentication URL and PIN so you can authorize a new account.',
      inputSchema: authUrlShape,
    },
    async (input: AuthUrlInput) => {
      toolsLogger.info('Auth URL generation requested', {
        has_custom_identifier: Boolean(input.client_identifier),
      });

      const result = await manager.generateAuthPin(input.client_identifier);

      return {
        content: [
          {
            type: 'text',
            text: [
              'Open the following URL in your browser and sign in to Plex to authorize access:',
              result.authorizationUrl,
              '',
              `PIN ID: ${result.pin.id}`,
              `Client Identifier: ${result.pin.clientIdentifier}`,
              `PIN Code: ${result.pin.code}`,
              `Expires At: ${result.pin.expiresAt}`,
              '',
              'After completing the login, run plex_check_auth_pin with the PIN ID and client identifier to retrieve the token.',
            ].join('\n'),
          },
        ],
        structuredContent: {
          authorization_url: result.authorizationUrl,
          pin: result.pin,
        } as Record<string, unknown>,
      };
    }
  );

  server.registerTool(
    'plex_check_auth_pin',
    {
      title: 'Check Plex Authorization PIN',
      description: 'Polls Plex for the status of an authorization PIN and returns the token when ready.',
      inputSchema: pollShape,
    },
    async (input: PollInput) => {
      toolsLogger.info('Auth PIN status requested', {
        pin_id: input.pin_id,
      });

      const status = await manager.checkAuthPinStatus(input.pin_id, input.client_identifier);
      const message = status.authToken
        ? 'Authorization complete. Use the returned auth token as your Plex API token.'
        : 'Authorization pending. Please complete the login flow in your browser.';

      return {
        content: [
          {
            type: 'text',
            text: [
              `PIN ID: ${status.id}`,
              `Client Identifier: ${status.clientIdentifier}`,
              `Expires At: ${status.expiresAt}`,
              `Auth Token Received: ${status.authToken ? 'yes' : 'no'}`,
              '',
              message,
            ].join('\n'),
          },
        ],
        structuredContent: {
          pin: status,
          message,
        } as Record<string, unknown>,
      };
    }
  );
}

function formatLookupSummary(result: Awaited<ReturnType<PlexAccountManager['searchUsers']>>): string {
  if (result.matches.length === 0) {
    return 'No matching Plex users were found.';
  }

  const lines = result.matches.map((match, index) => {
    const user = match.user;
    const identity = [user.username, user.email, user.title].filter(Boolean).join(' · ');
    return `${index + 1}. ${identity || 'Unknown'} — server: ${user.serverName} (account: ${user.accountLabel}) [score=${match.score.toFixed(3)}]`;
  });

  lines.push('', `Matches returned: ${result.matches.length}`, `Total users searched: ${result.totalSearched}`);
  return lines.join('\n');
}
