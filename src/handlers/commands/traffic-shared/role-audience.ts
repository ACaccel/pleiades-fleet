import {
  OverwriteType,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type PermissionOverwrites,
  type PermissionsBitField,
  type Role,
} from 'discord.js';

export type PermissionTarget = {
  readonly permissionOverwrites?: {
    readonly cache: ReadonlyMap<string, Pick<PermissionOverwrites, 'type' | 'allow' | 'deny'>>;
  };
  permissionsFor(subject: GuildMember | Role): Readonly<PermissionsBitField> | null;
};
interface RoleViewRule {
  readonly base: boolean;
  readonly baseRoles: ReadonlySet<string>;
  readonly allow: ReadonlySet<string>;
  readonly deny: ReadonlySet<string>;
}

/** Discord applies the everyone overwrite, then merged role denies and merged role allows. */
const roleViewRule = (guild: Guild, channel: PermissionTarget): RoleViewRule => {
  const everyoneId = guild.roles.everyone.id;
  const everyone = guild.roles.cache.get(everyoneId);
  let base = everyone?.permissions.has(PermissionFlagsBits.ViewChannel, false) ?? false;
  const baseRoles = new Set(
    [...guild.roles.cache.values()]
      .filter(
        (role) =>
          role.id !== everyoneId && role.permissions.has(PermissionFlagsBits.ViewChannel, false),
      )
      .map((role) => role.id),
  );
  const allow = new Set<string>();
  const deny = new Set<string>();
  for (const [id, overwrite] of channel.permissionOverwrites?.cache ?? []) {
    if (overwrite.type !== OverwriteType.Role) continue;
    const grants = overwrite.allow.has(PermissionFlagsBits.ViewChannel);
    const denies = overwrite.deny.has(PermissionFlagsBits.ViewChannel);
    if (id === everyoneId) {
      if (grants || denies) {
        base = grants;
        baseRoles.clear();
      }
    } else if (grants) allow.add(id);
    else if (denies) deny.add(id);
  }
  return { base, baseRoles, allow, deny };
};

/** Whether any non-admin role combination can satisfy a channel under these constraints. */
const canViewWith = (
  rule: RoleViewRule,
  roles: ReadonlySet<string>,
  forbidden: ReadonlySet<string>,
  requiredAny?: ReadonlySet<string>,
): boolean => {
  const available = (id: string): boolean => roles.has(id) && !forbidden.has(id);
  const satisfiesRequired = (accepts: (id: string) => boolean): boolean =>
    requiredAny === undefined || [...requiredAny].some(accepts);
  if (!satisfiesRequired(available)) return false;
  // One role allow beats every role deny, even when a different role supplied it.
  if ([...rule.allow].some(available)) return true;
  const withoutDenies = (id: string): boolean => available(id) && !rule.deny.has(id);
  return satisfiesRequired(withoutDenies) && (rule.base || [...rule.baseRoles].some(withoutDenies));
};

export const coversRoleCombinations = (
  guild: Guild,
  command: PermissionTarget,
  source: PermissionTarget,
): boolean => {
  const roles = new Set(
    [...guild.roles.cache.values()]
      .filter(
        (role) =>
          role.id !== guild.roles.everyone.id &&
          !role.permissions.has(PermissionFlagsBits.Administrator, false),
      )
      .map((role) => role.id),
  );
  const commandRule = roleViewRule(guild, command);
  const sourceRule = roleViewRule(guild, source);
  // A source is hidden when it has no allow and either no base grant or a role deny.
  if (
    !sourceRule.base &&
    canViewWith(commandRule, roles, new Set([...sourceRule.allow, ...sourceRule.baseRoles]))
  )
    return false;
  return !canViewWith(commandRule, roles, sourceRule.allow, sourceRule.deny);
};
