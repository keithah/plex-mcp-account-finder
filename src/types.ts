export interface PlexServerConnection {
  protocol: string;
  address: string;
  port: number;
  uri: string;
}

export interface PlexResource {
  name: string;
  provides: string;
  machineIdentifier: string;
  owned: boolean;
  product: string;
  version: string;
  platform: string;
  uri: string;
  connections: PlexServerConnection[];
}

export interface PlexServer {
  name: string;
  friendlyName: string;
  machineIdentifier: string;
  host: string;
  port: number;
  scheme: string;
  uri: string;
  product: string;
  version: string;
  platform: string;
  owned: boolean;
  accountLabel: string;
}

export interface PlexUserAccess {
  id: number | null;
  uuid: string | null;
  username: string | null;
  title: string | null;
  email: string | null;
  restricted: boolean | null;
  home: boolean | null;
  guest: boolean | null;
  canInvite: boolean | null;
  serverIdentifier: string;
  serverName: string;
  accountLabel: string;
}

export interface ConfigAccount {
  label: string;
  token: string;
  clientIdentifier?: string;
}
