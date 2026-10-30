import type { PermissionCode } from './permissions';
import type { RoleCode } from './roles';

/** Identidad resuelta de la petición: un usuario o un cliente de API. */
export interface AuthenticatedUser {
  kind: 'user';
  id: string;
  email: string;
  name: string;
  roles: RoleCode[];
  permissions: PermissionCode[];
  branchIds: string[];
  terminalId?: string;
  sessionId?: string;
}

export interface AuthenticatedApiClient {
  kind: 'api_client';
  id: string;
  name: string;
  channelId?: string;
  scopes: string[];
}

export type Principal = AuthenticatedUser | AuthenticatedApiClient;

export interface LoginResponse {
  accessToken: string;
  expiresIn: number;
  user: {
    id: string;
    email: string;
    username?: string;
    name: string;
    roles: RoleCode[];
    permissions: PermissionCode[];
    branchIds: string[];
    mustChangePassword: boolean;
  };
}
