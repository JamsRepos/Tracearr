/**
 * Rule management routes - CRUD for sharing detection rules
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import {
  createRuleSchema,
  updateRuleSchema,
  ruleIdParamSchema,
} from '@tracearr/shared';
import { db } from '../db/client.js';
import { rules, serverUsers, violations } from '../db/schema.js';

export const ruleRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /rules - List all rules
   */
  app.get(
    '/',
    { preHandler: [app.authenticate] },
    async (request) => {
      const authUser = request.user;

      // Get all rules, optionally with server user information
      const ruleList = await db
        .select({
          id: rules.id,
          name: rules.name,
          type: rules.type,
          params: rules.params,
          serverUserId: rules.serverUserId,
          username: serverUsers.username,
          isActive: rules.isActive,
          createdAt: rules.createdAt,
          updatedAt: rules.updatedAt,
        })
        .from(rules)
        .leftJoin(serverUsers, eq(rules.serverUserId, serverUsers.id))
        .orderBy(rules.name);

      // Filter out rules for users not in the accessible servers
      // Global rules (serverUserId = null) are always visible
      const filteredRules = ruleList.filter((rule) => {
        if (!rule.serverUserId) return true; // Global rule
        // For user-specific rules, we'd need to join through servers
        // For now, return all rules for owners
        return authUser.role === 'owner';
      });

      return { data: filteredRules };
    }
  );

  /**
   * POST /rules - Create a new rule
   */
  app.post(
    '/',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const body = createRuleSchema.safeParse(request.body);
      if (!body.success) {
        return reply.badRequest('Invalid request body');
      }

      const authUser = request.user;

      // Only owners can create rules
      if (authUser.role !== 'owner') {
        return reply.forbidden('Only server owners can create rules');
      }

      const { name, type, params, serverUserId, isActive } = body.data;

      // Verify serverUserId exists if provided
      if (serverUserId) {
        const serverUserRows = await db
          .select()
          .from(serverUsers)
          .where(eq(serverUsers.id, serverUserId))
          .limit(1);

        if (serverUserRows.length === 0) {
          return reply.notFound('Server user not found');
        }
      }

      // Create rule
      const inserted = await db
        .insert(rules)
        .values({
          name,
          type,
          params,
          serverUserId,
          isActive,
        })
        .returning();

      const rule = inserted[0];
      if (!rule) {
        return reply.internalServerError('Failed to create rule');
      }

      return reply.status(201).send(rule);
    }
  );

  /**
   * GET /rules/:id - Get a specific rule
   */
  app.get(
    '/:id',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const params = ruleIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.badRequest('Invalid rule ID');
      }

      const { id } = params.data;

      const ruleRows = await db
        .select({
          id: rules.id,
          name: rules.name,
          type: rules.type,
          params: rules.params,
          serverUserId: rules.serverUserId,
          username: serverUsers.username,
          isActive: rules.isActive,
          createdAt: rules.createdAt,
          updatedAt: rules.updatedAt,
        })
        .from(rules)
        .leftJoin(serverUsers, eq(rules.serverUserId, serverUsers.id))
        .where(eq(rules.id, id))
        .limit(1);

      const rule = ruleRows[0];
      if (!rule) {
        return reply.notFound('Rule not found');
      }

      // Get violation count for this rule
      const violationCount = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(violations)
        .where(eq(violations.ruleId, id));

      return {
        ...rule,
        violationCount: violationCount[0]?.count ?? 0,
      };
    }
  );

  /**
   * PATCH /rules/:id - Update a rule
   */
  app.patch(
    '/:id',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const params = ruleIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.badRequest('Invalid rule ID');
      }

      const body = updateRuleSchema.safeParse(request.body);
      if (!body.success) {
        return reply.badRequest('Invalid request body');
      }

      const { id } = params.data;
      const authUser = request.user;

      // Only owners can update rules
      if (authUser.role !== 'owner') {
        return reply.forbidden('Only server owners can update rules');
      }

      // Check rule exists
      const ruleRows = await db
        .select()
        .from(rules)
        .where(eq(rules.id, id))
        .limit(1);

      if (ruleRows.length === 0) {
        return reply.notFound('Rule not found');
      }

      // Build update object
      const updateData: Partial<{
        name: string;
        params: Record<string, unknown>;
        isActive: boolean;
        updatedAt: Date;
      }> = {
        updatedAt: new Date(),
      };

      if (body.data.name !== undefined) {
        updateData.name = body.data.name;
      }

      if (body.data.params !== undefined) {
        updateData.params = body.data.params;
      }

      if (body.data.isActive !== undefined) {
        updateData.isActive = body.data.isActive;
      }

      // Update rule
      const updated = await db
        .update(rules)
        .set(updateData)
        .where(eq(rules.id, id))
        .returning();

      const updatedRule = updated[0];
      if (!updatedRule) {
        return reply.internalServerError('Failed to update rule');
      }

      return updatedRule;
    }
  );

  /**
   * DELETE /rules/:id - Delete a rule
   */
  app.delete(
    '/:id',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const params = ruleIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.badRequest('Invalid rule ID');
      }

      const { id } = params.data;
      const authUser = request.user;

      // Only owners can delete rules
      if (authUser.role !== 'owner') {
        return reply.forbidden('Only server owners can delete rules');
      }

      // Check rule exists
      const ruleRows = await db
        .select()
        .from(rules)
        .where(eq(rules.id, id))
        .limit(1);

      if (ruleRows.length === 0) {
        return reply.notFound('Rule not found');
      }

      // Delete rule (cascade will handle violations)
      await db.delete(rules).where(eq(rules.id, id));

      return { success: true };
    }
  );
};
