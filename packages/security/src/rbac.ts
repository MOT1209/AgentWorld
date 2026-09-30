/**
 * Human role-based access control.
 *
 * Read-only for OBSERVER, operational for ADMIN, unrestricted for OWNER.
 * Deliberately coarse: Phase 1 has exactly one human account model (the owner
 * who built the company). Finer-grained human roles are a Phase 2 concern and
 * would be theatre until then.
 */
import { PERMISSIONS, type Permission } from "./permissions.js";
import { UserRole, type ActorRef } from "../../shared/src/index.js";

const OBSERVER_PERMISSIONS: Permission[] = [
  PERMISSIONS.WORLD_READ,
  PERMISSIONS.COMPANY_READ,
  PERMISSIONS.COMPANY_TREASURY_VIEW,
  PERMISSIONS.AGENT_READ,
  PERMISSIONS.AGENT_RUN,
  PERMISSIONS.TASK_READ,
  PERMISSIONS.TASK_CREATE,
  PERMISSIONS.TASK_UPDATE,
  PERMISSIONS.MESSAGE_READ,
  PERMISSIONS.MESSAGE_SEND,
  PERMISSIONS.MEMORY_READ,
  PERMISSIONS.WALLET_READ,
  PERMISSIONS.TRANSACTION_READ,
  PERMISSIONS.APPROVAL_READ,
  PERMISSIONS.EVENT_READ,
];

const ADMIN_PERMISSIONS: Permission[] = [
  ...OBSERVER_PERMISSIONS,
  PERMISSIONS.WORLD_WRITE,
  PERMISSIONS.COMPANY_WRITE,
  PERMISSIONS.AGENT_CREATE,
  PERMISSIONS.AGENT_MODIFY,
  PERMISSIONS.TASK_ASSIGN,
  PERMISSIONS.TASK_COMPLETE,
  PERMISSIONS.TASK_CANCEL,
  PERMISSIONS.MEMORY_WRITE,
  PERMISSIONS.APPROVAL_REQUEST,
  PERMISSIONS.APPROVAL_DECIDE,
];

const OWNER_PERMISSIONS: Permission[] = [
  ...ADMIN_PERMISSIONS,
  PERMISSIONS.COMPANY_STRUCTURE_MODIFY,
  PERMISSIONS.AGENT_DELETE,
  PERMISSIONS.WALLET_TRANSFER,
  PERMISSIONS.WALLET_WITHDRAW,
  PERMISSIONS.AUDIT_READ,
];

const ROLE_PERMISSIONS: Record<UserRole, ReadonlySet<Permission>> = {
  [UserRole.OBSERVER]: new Set(OBSERVER_PERMISSIONS),
  [UserRole.ADMIN]: new Set(ADMIN_PERMISSIONS),
  [UserRole.OWNER]: new Set(OWNER_PERMISSIONS),
};

export function permissionsForRole(role: UserRole): Permission[] {
  return [...(ROLE_PERMISSIONS[role] ?? ROLE_PERMISSIONS[UserRole.OBSERVER])];
}

export function roleHasPermission(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

/**
 * The authenticated human principal carried on the request.
 * Distinct from ActorRef: agents never become request principals.
 */
export interface Principal {
  userId: string;
  email: string;
  displayName: string;
  role: UserRole;
  permissions: ReadonlySet<Permission>;
}

export function buildPrincipal(user: {
  id: string;
  email: string;
  displayName: string;
  role: string;
}): Principal {
  const role = (user.role as UserRole) ?? UserRole.OBSERVER;
  return {
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
    role,
    permissions: new Set(permissionsForRole(role)),
  };
}

export function principalCan(principal: Principal, permission: Permission): boolean {
  return principal.permissions.has(permission);
}

export function principalToActor(principal: Principal): ActorRef {
  return {
    actorType: "USER",
    actorId: principal.userId,
    actorName: principal.displayName,
  };
}
