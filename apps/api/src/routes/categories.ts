import type { FastifyInstance } from 'fastify';
import { and, asc, eq, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { assets, categories, ID_LENGTH } from '@hovod/db';
import { db } from '../db.js';
import { AppError } from '../middleware/error-handler.js';

const categoryBody = z.object({
  name: z.string().trim().min(1).max(100),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color must be a #rrggbb hex value').optional(),
});
const updateCategoryBody = categoryBody.partial();

/** MySQL duplicate-key errno for the (org_id, name) unique index. */
function isDuplicateName(error: unknown) {
  return typeof error === 'object' && error !== null && (error as { errno?: number }).errno === 1062;
}

/** Resolve a category within the caller's org. Cross-org ids are indistinguishable from missing ones. */
export async function findCategoryOrFail(id: string, orgId: string | null | undefined) {
  const [category] = await db.select().from(categories)
    .where(and(eq(categories.id, id), eq(categories.orgId, orgId!)))
    .limit(1);
  if (!category) throw new AppError(404, 'Category not found', 'CATEGORY_NOT_FOUND');
  return category;
}

export async function categoryRoutes(app: FastifyInstance) {
  /* List categories with the number of videos in each */
  app.get('/v1/categories', async (request) => {
    const list = await db
      .select({
        id: categories.id,
        name: categories.name,
        color: categories.color,
        createdAt: categories.createdAt,
        assetCount: sql<number>`count(${assets.id})`.mapWith(Number),
      })
      .from(categories)
      .leftJoin(assets, eq(assets.categoryId, categories.id))
      .where(eq(categories.orgId, request.orgId!))
      .groupBy(categories.id)
      .orderBy(asc(categories.name));
    return { data: list };
  });

  /* Create category */
  app.post<{ Body: z.infer<typeof categoryBody> }>('/v1/categories', async (request, reply) => {
    const body = categoryBody.parse(request.body);
    const id = nanoid(ID_LENGTH.CATEGORY);
    try {
      await db.insert(categories).values({
        id,
        orgId: request.orgId!,
        name: body.name,
        color: body.color ?? null,
      });
    } catch (error) {
      if (isDuplicateName(error)) throw new AppError(409, 'A category with that name already exists', 'CATEGORY_NAME_TAKEN');
      throw error;
    }
    reply.code(201);
    return { data: { id, name: body.name, color: body.color ?? null, assetCount: 0 } };
  });

  /* Update category */
  app.patch<{ Params: { id: string }; Body: z.infer<typeof updateCategoryBody> }>('/v1/categories/:id', async (request) => {
    const body = updateCategoryBody.parse(request.body);
    if (body.name === undefined && body.color === undefined) throw new AppError(400, 'Nothing to update');
    const category = await findCategoryOrFail(request.params.id, request.orgId);
    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.color !== undefined) updates.color = body.color;
    try {
      await db.update(categories).set(updates).where(eq(categories.id, category.id));
    } catch (error) {
      if (isDuplicateName(error)) throw new AppError(409, 'A category with that name already exists', 'CATEGORY_NAME_TAKEN');
      throw error;
    }
    return { data: { id: category.id, ...updates } };
  });

  /* Delete category — assets keep existing and fall back to uncategorized (FK ON DELETE SET NULL) */
  app.delete<{ Params: { id: string } }>('/v1/categories/:id', async (request) => {
    const category = await findCategoryOrFail(request.params.id, request.orgId);
    await db.delete(categories).where(eq(categories.id, category.id));
    return { data: { id: category.id, deleted: true } };
  });
}
