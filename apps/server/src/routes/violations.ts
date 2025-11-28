/**
 * Violation management routes
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq, and, desc, gte, lte, isNull, isNotNull, sql } from 'drizzle-orm';
import {
  violationQuerySchema,
  violationIdParamSchema,
} from '@tracearr/shared';
import { db } from '../db/client.js';
import { violations, rules, users, sessions } from '../db/schema.js';

export const violationRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /violations - List violations with pagination and filters
   */
  app.get(
    '/',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = violationQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const {
        page = 1,
        pageSize = 50,
        userId,
        ruleId,
        severity,
        acknowledged,
        startDate,
        endDate,
      } = query.data;

      const authUser = request.user;
      const offset = (page - 1) * pageSize;

      // Build conditions
      const conditions = [];

      if (userId) {
        conditions.push(eq(violations.userId, userId));
      }

      if (ruleId) {
        conditions.push(eq(violations.ruleId, ruleId));
      }

      if (severity) {
        conditions.push(eq(violations.severity, severity));
      }

      if (acknowledged === true) {
        conditions.push(isNotNull(violations.acknowledgedAt));
      } else if (acknowledged === false) {
        conditions.push(isNull(violations.acknowledgedAt));
      }

      if (startDate) {
        conditions.push(gte(violations.createdAt, startDate));
      }

      if (endDate) {
        conditions.push(lte(violations.createdAt, endDate));
      }

      // Query violations with joins
      const violationData = await db
        .select({
          id: violations.id,
          ruleId: violations.ruleId,
          ruleName: rules.name,
          ruleType: rules.type,
          userId: violations.userId,
          username: users.username,
          userThumb: users.thumbUrl,
          sessionId: violations.sessionId,
          mediaTitle: sessions.mediaTitle,
          severity: violations.severity,
          data: violations.data,
          createdAt: violations.createdAt,
          acknowledgedAt: violations.acknowledgedAt,
        })
        .from(violations)
        .innerJoin(rules, eq(violations.ruleId, rules.id))
        .innerJoin(users, eq(violations.userId, users.id))
        .innerJoin(sessions, eq(violations.sessionId, sessions.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(violations.createdAt))
        .limit(pageSize)
        .offset(offset);

      // Filter by user's accessible servers
      const filteredViolations = violationData.filter(() => {
        // For now, show all violations to owners
        return authUser.role === 'owner';
      });

      // Get total count
      const countResult = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(violations)
        .where(conditions.length > 0 ? and(...conditions) : undefined);

      const total = countResult[0]?.count ?? 0;

      return {
        data: filteredViolations,
        pagination: {
          page,
          pageSize,
          total,
          totalPages: Math.ceil(total / pageSize),
        },
      };
    }
  );

  /**
   * GET /violations/:id - Get a specific violation
   */
  app.get(
    '/:id',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const params = violationIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.badRequest('Invalid violation ID');
      }

      const { id } = params.data;

      const violationRows = await db
        .select({
          id: violations.id,
          ruleId: violations.ruleId,
          ruleName: rules.name,
          ruleType: rules.type,
          userId: violations.userId,
          username: users.username,
          userThumb: users.thumbUrl,
          sessionId: violations.sessionId,
          mediaTitle: sessions.mediaTitle,
          ipAddress: sessions.ipAddress,
          geoCity: sessions.geoCity,
          geoCountry: sessions.geoCountry,
          playerName: sessions.playerName,
          platform: sessions.platform,
          severity: violations.severity,
          data: violations.data,
          createdAt: violations.createdAt,
          acknowledgedAt: violations.acknowledgedAt,
        })
        .from(violations)
        .innerJoin(rules, eq(violations.ruleId, rules.id))
        .innerJoin(users, eq(violations.userId, users.id))
        .innerJoin(sessions, eq(violations.sessionId, sessions.id))
        .where(eq(violations.id, id))
        .limit(1);

      const violation = violationRows[0];
      if (!violation) {
        return reply.notFound('Violation not found');
      }

      return violation;
    }
  );

  /**
   * PATCH /violations/:id - Acknowledge a violation
   */
  app.patch(
    '/:id',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const params = violationIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.badRequest('Invalid violation ID');
      }

      const { id } = params.data;
      const authUser = request.user;

      // Only owners can acknowledge violations
      if (authUser.role !== 'owner') {
        return reply.forbidden('Only server owners can acknowledge violations');
      }

      // Check violation exists
      const violationRows = await db
        .select()
        .from(violations)
        .where(eq(violations.id, id))
        .limit(1);

      if (violationRows.length === 0) {
        return reply.notFound('Violation not found');
      }

      // Update acknowledgment
      const updated = await db
        .update(violations)
        .set({
          acknowledgedAt: new Date(),
        })
        .where(eq(violations.id, id))
        .returning({
          id: violations.id,
          acknowledgedAt: violations.acknowledgedAt,
        });

      const updatedViolation = updated[0];
      if (!updatedViolation) {
        return reply.internalServerError('Failed to acknowledge violation');
      }

      return {
        success: true,
        acknowledgedAt: updatedViolation.acknowledgedAt,
      };
    }
  );

  /**
   * DELETE /violations/:id - Dismiss (delete) a violation
   */
  app.delete(
    '/:id',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const params = violationIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.badRequest('Invalid violation ID');
      }

      const { id } = params.data;
      const authUser = request.user;

      // Only owners can delete violations
      if (authUser.role !== 'owner') {
        return reply.forbidden('Only server owners can dismiss violations');
      }

      // Check violation exists
      const violationRows = await db
        .select()
        .from(violations)
        .where(eq(violations.id, id))
        .limit(1);

      if (violationRows.length === 0) {
        return reply.notFound('Violation not found');
      }

      // Delete violation
      await db.delete(violations).where(eq(violations.id, id));

      return { success: true };
    }
  );
};
