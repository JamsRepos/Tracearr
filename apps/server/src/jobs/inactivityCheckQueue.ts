/**
 * Inactivity Check Queue - BullMQ-based periodic account inactivity checking
 *
 * Monitors user accounts for periods of no activity and creates violations
 * when accounts have been inactive for configurable time periods.
 */

import { Queue, Worker, type Job, type ConnectionOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { eq, and, isNull } from 'drizzle-orm';
import type { Rule, AccountInactivityParams, ViolationWithDetails } from '@tracearr/shared';
import { WS_EVENTS, TIME_MS } from '@tracearr/shared';
import { db } from '../db/client.js';
import { rules, serverUsers, violations, users, servers } from '../db/schema.js';
import { ruleEngine } from '../services/rules.js';
import { enqueueNotification } from './notificationQueue.js';

// Queue name
const QUEUE_NAME = 'inactivity-check';

// Fixed check interval (1 hour)
const CHECK_INTERVAL_MS = TIME_MS.HOUR;

// Startup delay before first check (5 minutes) - allows server to fully initialize
const STARTUP_DELAY_MS = 5 * TIME_MS.MINUTE;

// Job types
interface InactivityCheckJobData {
  type: 'check';
  ruleId?: string; // If set, only check this specific rule
}

// Connection options (set during initialization)
let connectionOptions: ConnectionOptions | null = null;

// Queue and worker instances
let inactivityQueue: Queue<InactivityCheckJobData> | null = null;
let inactivityWorker: Worker<InactivityCheckJobData> | null = null;

// Redis client reference (kept for potential future use with caching)
let _redisClient: Redis | null = null;

// Pub/sub service for broadcasting violations
let pubSubPublish: ((event: string, data: unknown) => Promise<void>) | null = null;

/**
 * Initialize the inactivity check queue with Redis connection
 */
export function initInactivityCheckQueue(
  redisUrl: string,
  redis: Redis,
  publishFn: (event: string, data: unknown) => Promise<void>
): void {
  if (inactivityQueue) {
    console.log('[Inactivity] Queue already initialized');
    return;
  }

  connectionOptions = { url: redisUrl };
  _redisClient = redis;
  pubSubPublish = publishFn;

  // Create the inactivity check queue
  inactivityQueue = new Queue<InactivityCheckJobData>(QUEUE_NAME, {
    connection: connectionOptions,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 10000, // 10s, 20s, 40s
      },
      removeOnComplete: {
        count: 50, // Keep last 50 for debugging
        age: 7 * 24 * 60 * 60, // 7 days
      },
      removeOnFail: {
        count: 100,
        age: 7 * 24 * 60 * 60, // 7 days
      },
    },
  });

  console.log('[Inactivity] Queue initialized');
}

/**
 * Start the inactivity check worker
 */
export function startInactivityCheckWorker(): void {
  if (!connectionOptions) {
    throw new Error('Inactivity check queue not initialized. Call initInactivityCheckQueue first.');
  }

  if (inactivityWorker) {
    console.log('[Inactivity] Worker already running');
    return;
  }

  inactivityWorker = new Worker<InactivityCheckJobData>(
    QUEUE_NAME,
    async (job: Job<InactivityCheckJobData>) => {
      const startTime = Date.now();
      try {
        await processInactivityCheck(job);
        const duration = Date.now() - startTime;
        console.log(`[Inactivity] Job ${job.id} completed in ${duration}ms`);
      } catch (error) {
        const duration = Date.now() - startTime;
        console.error(`[Inactivity] Job ${job.id} failed after ${duration}ms:`, error);
        throw error;
      }
    },
    {
      connection: connectionOptions,
      concurrency: 1, // Only one check at a time to avoid DB contention
    }
  );

  inactivityWorker.on('error', (error) => {
    console.error('[Inactivity] Worker error:', error);
  });

  console.log('[Inactivity] Worker started');
}

/**
 * Schedule inactivity checks based on active rules
 * Called on startup and when rules are created/updated/deleted
 */
export async function scheduleInactivityChecks(): Promise<void> {
  if (!inactivityQueue) {
    console.error('[Inactivity] Queue not initialized');
    return;
  }

  // Remove any existing job schedulers
  const schedulers = await inactivityQueue.getJobSchedulers();
  for (const scheduler of schedulers) {
    if (scheduler.id) {
      await inactivityQueue.removeJobScheduler(scheduler.id);
    }
  }

  // Get all active account_inactivity rules
  const activeRules = await db
    .select({
      id: rules.id,
    })
    .from(rules)
    .where(and(eq(rules.isActive, true), eq(rules.type, 'account_inactivity')));

  if (activeRules.length === 0) {
    console.log('[Inactivity] No active inactivity rules found');
    return;
  }

  // Schedule a single recurring job that checks all rules hourly
  await inactivityQueue.add(
    'scheduled-check',
    { type: 'check' },
    {
      repeat: {
        every: CHECK_INTERVAL_MS,
      },
      jobId: 'inactivity-check-repeatable',
    }
  );

  // Schedule a delayed startup check to allow server to fully initialize
  // This prevents false positives during server startup
  await inactivityQueue.add(
    'startup-check',
    { type: 'check' },
    {
      delay: STARTUP_DELAY_MS,
      jobId: `startup-${Date.now()}`,
    }
  );

  console.log(`[Inactivity] Scheduled hourly checks for ${activeRules.length} rule(s)`);
}

/**
 * Trigger an immediate inactivity check for all rules or a specific rule
 */
export async function triggerInactivityCheck(ruleId?: string): Promise<void> {
  if (!inactivityQueue) {
    console.error('[Inactivity] Queue not initialized');
    return;
  }

  await inactivityQueue.add(
    'manual-check',
    { type: 'check', ruleId },
    { jobId: `manual-${Date.now()}` }
  );
}

/**
 * Process an inactivity check job
 */
async function processInactivityCheck(job: Job<InactivityCheckJobData>): Promise<void> {
  console.log(`[Inactivity] Processing check (job ${job.id})`);

  // Get all active account_inactivity rules (or a specific one if ruleId is set)
  const ruleQuery = db
    .select()
    .from(rules)
    .where(
      job.data.ruleId
        ? and(eq(rules.id, job.data.ruleId), eq(rules.type, 'account_inactivity'))
        : and(eq(rules.isActive, true), eq(rules.type, 'account_inactivity'))
    );

  const activeRules = await ruleQuery;

  if (activeRules.length === 0) {
    console.log('[Inactivity] No active inactivity rules to check');
    return;
  }

  let totalViolations = 0;

  for (const rule of activeRules) {
    const params = rule.params as unknown as AccountInactivityParams;
    console.log(`[Inactivity] Checking rule: ${rule.name} (${rule.id})`);

    // Get users to check based on rule scope
    let usersToCheck;
    if (rule.serverUserId) {
      // Per-user rule - only check this specific user
      usersToCheck = await db
        .select({
          id: serverUsers.id,
          username: serverUsers.username,
          lastActivityAt: serverUsers.lastActivityAt,
          serverId: serverUsers.serverId,
        })
        .from(serverUsers)
        .where(eq(serverUsers.id, rule.serverUserId));
    } else {
      // Global rule - check all users
      usersToCheck = await db
        .select({
          id: serverUsers.id,
          username: serverUsers.username,
          lastActivityAt: serverUsers.lastActivityAt,
          serverId: serverUsers.serverId,
        })
        .from(serverUsers);
    }

    console.log(`[Inactivity] Checking ${usersToCheck.length} users for rule ${rule.name}`);

    for (const user of usersToCheck) {
      // Evaluate inactivity for this user
      const result = ruleEngine.evaluateAccountInactivity(user, params);

      if (result.violated) {
        // Only create violation if no existing unacknowledged violation exists
        const shouldCreate = await shouldCreateViolation(user.id, rule.id);

        if (shouldCreate) {
          await createInactivityViolation(rule as unknown as Rule, user, result);
          totalViolations++;
        }
      }
    }
  }

  console.log(`[Inactivity] Check complete. Created ${totalViolations} violations.`);
}

/**
 * Check if we should create a new violation
 * Only creates a violation if no existing unacknowledged violation exists
 */
async function shouldCreateViolation(serverUserId: string, ruleId: string): Promise<boolean> {
  // Only create if no existing unacknowledged violation exists
  const existing = await db
    .select({ id: violations.id })
    .from(violations)
    .where(
      and(
        eq(violations.serverUserId, serverUserId),
        eq(violations.ruleId, ruleId),
        isNull(violations.acknowledgedAt)
      )
    )
    .limit(1);

  return existing.length === 0;
}

/**
 * Create an inactivity violation (no associated session)
 */
async function createInactivityViolation(
  rule: Rule,
  user: { id: string; username: string; serverId: string },
  result: { severity: string; data: Record<string, unknown> }
): Promise<void> {
  // Insert violation without session reference
  const created = await db.transaction(async (tx) => {
    const insertedRows = await tx
      .insert(violations)
      .values({
        ruleId: rule.id,
        serverUserId: user.id,
        sessionId: null, // No session for inactivity violations
        severity: result.severity as 'low' | 'warning' | 'high',
        ruleType: 'account_inactivity',
        data: result.data,
      })
      .onConflictDoNothing()
      .returning();

    return insertedRows[0];
  });

  if (!created) {
    console.log(`[Inactivity] Duplicate violation prevented for user ${user.username}`);
    return;
  }

  // Get user and server details for broadcasting
  const [details] = await db
    .select({
      userId: serverUsers.id,
      username: serverUsers.username,
      thumbUrl: serverUsers.thumbUrl,
      identityName: users.name,
      serverId: servers.id,
      serverName: servers.name,
      serverType: servers.type,
    })
    .from(serverUsers)
    .innerJoin(users, eq(serverUsers.userId, users.id))
    .innerJoin(servers, eq(servers.id, serverUsers.serverId))
    .where(eq(serverUsers.id, user.id))
    .limit(1);

  if (!details) {
    console.warn(`[Inactivity] Could not find details for user ${user.id}`);
    return;
  }

  // Broadcast violation event
  if (pubSubPublish) {
    const violationWithDetails: ViolationWithDetails = {
      id: created.id,
      ruleId: created.ruleId,
      serverUserId: created.serverUserId,
      sessionId: created.sessionId,
      severity: created.severity,
      data: created.data,
      acknowledgedAt: created.acknowledgedAt,
      createdAt: created.createdAt,
      user: {
        id: details.userId,
        username: details.username,
        thumbUrl: details.thumbUrl,
        serverId: details.serverId,
        identityName: details.identityName,
      },
      rule: {
        id: rule.id,
        name: rule.name,
        type: rule.type,
      },
      server: {
        id: details.serverId,
        name: details.serverName,
        type: details.serverType,
      },
    };

    await pubSubPublish(WS_EVENTS.VIOLATION_NEW, violationWithDetails);
    console.log(`[Inactivity] Violation created: ${rule.name} for user ${details.username}`);

    // Enqueue notification for async dispatch (Discord, webhooks, push)
    await enqueueNotification({ type: 'violation', payload: violationWithDetails });
  }
}

/**
 * Gracefully shutdown the inactivity check queue and worker
 */
export async function shutdownInactivityCheckQueue(): Promise<void> {
  console.log('[Inactivity] Shutting down queue...');

  if (inactivityWorker) {
    await inactivityWorker.close();
    inactivityWorker = null;
  }

  if (inactivityQueue) {
    await inactivityQueue.close();
    inactivityQueue = null;
  }

  _redisClient = null;
  pubSubPublish = null;

  console.log('[Inactivity] Queue shutdown complete');
}

/**
 * Get the inactivity check queue instance (for testing or external scheduling)
 */
export function getInactivityQueue(): Queue<InactivityCheckJobData> | null {
  return inactivityQueue;
}
