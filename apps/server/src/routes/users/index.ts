/**
 * User Routes Module
 *
 * Orchestrates all user-related routes and provides unified export.
 *
 * Routes:
 * - GET / - List all users with pagination
 * - GET /:id - Get user details
 * - PATCH /:id - Update user
 * - GET /:id/sessions - Get user's session history
 * - GET /:id/locations - Get user's unique locations
 * - GET /:id/devices - Get user's unique devices
 */

import type { FastifyPluginAsync } from 'fastify';
import { listRoutes } from './list.js';
import { sessionsRoutes } from './sessions.js';
import { locationsRoutes } from './locations.js';
import { devicesRoutes } from './devices.js';

export const userRoutes: FastifyPluginAsync = async (app) => {
  // Register all sub-route plugins
  // Each plugin defines its own paths (no additional prefix needed)
  await app.register(listRoutes);
  await app.register(sessionsRoutes);
  await app.register(locationsRoutes);
  await app.register(devicesRoutes);
};
