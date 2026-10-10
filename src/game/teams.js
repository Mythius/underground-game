import { config } from '../config.js';

/**
 * Teams: invite a player, they accept, and you see each other on the map. Membership is per
 * connection (client), so it survives dying and respawning. A team of one disbands.
 */
export class Teams {
  constructor() {
    this.nextId = 1;
    this.teams = new Map(); // team id -> Set of clients
    this.invites = new Map(); // invited client -> Map(inviter client -> expires at, ms)
    this.changed = new Set(); // clients whose team panel needs resending
  }

  teamOf(client) {
    return client.team ? this.teams.get(client.team) ?? null : null;
  }

  /** My teammates (not me). */
  mates(client) {
    const team = this.teamOf(client);
    return team ? [...team].filter((c) => c !== client) : [];
  }

  invite(from, to, now = Date.now()) {
    if (from === to) return 'team_self';
    if (from.team && from.team === to.team) return 'team_already';
    if ((this.teamOf(from)?.size ?? 1) >= config.teams.maxSize) return 'team_full';
    if (!this.invites.has(to)) this.invites.set(to, new Map());
    this.invites.get(to).set(from, now + config.teams.inviteSec * 1000);
    this.changed.add(to);
    return null;
  }

  /** Accept `from`'s invite: leave any team you're in and join theirs (made now if they had none). */
  accept(client, from, now = Date.now()) {
    const expires = this.invites.get(client)?.get(from);
    if (!expires || expires < now || !from.room) {
      this.decline(client, from);
      return 'team_no_invite';
    }
    let team = this.teamOf(from);
    if ((team?.size ?? 1) >= config.teams.maxSize) return 'team_full';
    this.decline(client, from);
    this.leave(client);
    if (!team) {
      from.team = this.nextId++;
      team = new Set([from]);
      this.teams.set(from.team, team);
    }
    client.team = from.team;
    team.add(client);
    for (const c of team) this.changed.add(c);
    return null;
  }

  decline(client, from) {
    this.invites.get(client)?.delete(from);
    this.changed.add(client);
  }

  leave(client) {
    const team = this.teamOf(client);
    client.team = 0;
    this.changed.add(client);
    if (!team) return;
    team.delete(client);
    for (const c of team) this.changed.add(c);
    if (team.size <= 1) {
      for (const c of team) c.team = 0;
      this.teams.delete([...this.teams].find(([, t]) => t === team)?.[0]);
    }
  }

  /** Gone for good (disconnected or moved rooms): out of their team, and their invites with them. */
  remove(client) {
    this.leave(client);
    this.invites.delete(client);
    for (const [to, from] of this.invites) if (from.delete(client)) this.changed.add(to);
    this.changed.delete(client);
  }

  /** What the team panel shows: members (with player ids, for the map) and invites waiting. */
  describe(client, now = Date.now()) {
    const team = this.teamOf(client);
    const invites = [];
    for (const [from, expires] of this.invites.get(client) ?? []) {
      if (expires < now) this.invites.get(client).delete(from);
      else invites.push({ id: from.id, name: from.name });
    }
    return {
      members: team ? [...team].map((c) => ({ id: c.id, name: c.name, player: c.player?.alive ? c.player.id : 0, me: c === client })) : [],
      invites,
      max: config.teams.maxSize,
    };
  }
}
