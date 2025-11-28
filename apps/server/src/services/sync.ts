/**
 * Server sync service - imports users and libraries from Plex/Jellyfin
 */

import { eq, and } from 'drizzle-orm';
import { db } from '../db/client.js';
import { servers, users } from '../db/schema.js';
import { PlexService, type PlexTvUser, type PlexLibrary } from './plex.js';
import { JellyfinService, type JellyfinUser } from './jellyfin.js';
import { decrypt } from '../utils/crypto.js';

export interface SyncResult {
  usersAdded: number;
  usersUpdated: number;
  librariesSynced: number;
  errors: string[];
}

export interface SyncOptions {
  syncUsers?: boolean;
  syncLibraries?: boolean;
}

/**
 * Sync users from Plex server to local database
 */
async function syncPlexUsers(
  serverId: string,
  token: string,
  serverUrl: string
): Promise<{ added: number; updated: number; errors: string[] }> {
  const errors: string[] = [];
  let added = 0;
  let updated = 0;

  try {
    // Get server machine identifier for shared_servers API
    const response = await fetch(`${serverUrl}`, {
      headers: {
        'X-Plex-Token': token,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to connect to Plex server: ${response.status}`);
    }

    const serverInfo = (await response.json()) as {
      MediaContainer?: { machineIdentifier?: string };
    };
    const machineIdentifier = serverInfo.MediaContainer?.machineIdentifier;

    if (!machineIdentifier) {
      throw new Error('Could not get server machine identifier');
    }

    // Get all users with their library access from Plex.tv
    const plexUsers = await PlexService.getAllUsersWithLibraries(token, machineIdentifier);

    for (const plexUser of plexUsers) {
      try {
        // Check if user exists
        const existing = await db
          .select()
          .from(users)
          .where(and(eq(users.serverId, serverId), eq(users.externalId, plexUser.id)))
          .limit(1);

        if (existing.length > 0) {
          // Update existing user
          await db
            .update(users)
            .set({
              username: plexUser.username || plexUser.title,
              email: plexUser.email || null,
              thumbUrl: plexUser.thumb || null,
              isOwner: plexUser.isAdmin,
              updatedAt: new Date(),
            })
            .where(eq(users.id, existing[0]!.id));
          updated++;
        } else {
          // Insert new user
          await db.insert(users).values({
            serverId,
            externalId: plexUser.id,
            username: plexUser.username || plexUser.title,
            email: plexUser.email || null,
            thumbUrl: plexUser.thumb || null,
            isOwner: plexUser.isAdmin,
          });
          added++;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        errors.push(`Failed to sync user ${plexUser.username}: ${message}`);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    errors.push(`Plex user sync failed: ${message}`);
  }

  return { added, updated, errors };
}

/**
 * Sync users from Jellyfin server to local database
 */
async function syncJellyfinUsers(
  serverId: string,
  serverUrl: string,
  encryptedToken: string
): Promise<{ added: number; updated: number; errors: string[] }> {
  const errors: string[] = [];
  let added = 0;
  let updated = 0;

  try {
    const jellyfinService = new JellyfinService({
      id: serverId,
      name: '',
      type: 'jellyfin',
      url: serverUrl,
      token: encryptedToken,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);
    const jellyfinUsers = await jellyfinService.getUsers();

    for (const jfUser of jellyfinUsers) {
      try {
        // Check if user exists
        const existing = await db
          .select()
          .from(users)
          .where(and(eq(users.serverId, serverId), eq(users.externalId, jfUser.id)))
          .limit(1);

        if (existing.length > 0) {
          // Update existing user
          await db
            .update(users)
            .set({
              username: jfUser.name,
              isOwner: jfUser.isAdministrator,
              updatedAt: new Date(),
            })
            .where(eq(users.id, existing[0]!.id));
          updated++;
        } else {
          // Insert new user
          await db.insert(users).values({
            serverId,
            externalId: jfUser.id,
            username: jfUser.name,
            isOwner: jfUser.isAdministrator,
          });
          added++;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        errors.push(`Failed to sync user ${jfUser.name}: ${message}`);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    errors.push(`Jellyfin user sync failed: ${message}`);
  }

  return { added, updated, errors };
}

/**
 * Sync a single server (users and libraries)
 */
export async function syncServer(
  serverId: string,
  options: SyncOptions = { syncUsers: true, syncLibraries: true }
): Promise<SyncResult> {
  const result: SyncResult = {
    usersAdded: 0,
    usersUpdated: 0,
    librariesSynced: 0,
    errors: [],
  };

  // Get server details
  const serverRows = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
  const server = serverRows[0];

  if (!server) {
    result.errors.push(`Server not found: ${serverId}`);
    return result;
  }

  const token = decrypt(server.token);
  const serverUrl = server.url.replace(/\/$/, '');

  // Sync users
  if (options.syncUsers) {
    if (server.type === 'plex') {
      const userResult = await syncPlexUsers(serverId, token, serverUrl);
      result.usersAdded = userResult.added;
      result.usersUpdated = userResult.updated;
      result.errors.push(...userResult.errors);
    } else if (server.type === 'jellyfin') {
      // Pass encrypted token - JellyfinService will decrypt
      const userResult = await syncJellyfinUsers(serverId, serverUrl, server.token);
      result.usersAdded = userResult.added;
      result.usersUpdated = userResult.updated;
      result.errors.push(...userResult.errors);
    }
  }

  // Sync libraries (just count for now - libraries stored on server)
  if (options.syncLibraries) {
    try {
      if (server.type === 'plex') {
        const plexService = new PlexService(server as any);
        const libraries = await plexService.getLibraries();
        result.librariesSynced = libraries.length;
      } else if (server.type === 'jellyfin') {
        const jellyfinService = new JellyfinService(server as any);
        const libraries = await jellyfinService.getLibraries();
        result.librariesSynced = libraries.length;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      result.errors.push(`Library sync failed: ${message}`);
    }
  }

  return result;
}

/**
 * Sync all configured servers
 */
export async function syncAllServers(
  options: SyncOptions = { syncUsers: true, syncLibraries: true }
): Promise<Map<string, SyncResult>> {
  const results = new Map<string, SyncResult>();

  const allServers = await db.select().from(servers);

  for (const server of allServers) {
    const result = await syncServer(server.id, options);
    results.set(server.id, result);
  }

  return results;
}
