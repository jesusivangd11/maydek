import { Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '@pv/shared-types';
import { AuditService } from '../../core/audit/audit.service';
import { PrismaService } from '../../core/database/prisma.service';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors/domain-errors';
import { newId } from '../../core/ids';
import type { CreateCategoryDto, UpdateCategoryDto } from './dto/catalog.dto';

/** Convierte "Ropa de Niño" en "ropa-de-nino": estable y legible en una URL. */
function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Árbol de un solo nivel de anidamiento, que es lo que un comercio usa. */
  async list(includeInactive = false) {
    const categories = await this.prisma.client.category.findMany({
      where: { deletedAt: null, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        slug: true,
        parentId: true,
        position: true,
        isActive: true,
        _count: { select: { products: true } },
      },
    });

    return categories.map((category) => ({
      id: category.id,
      name: category.name,
      slug: category.slug,
      parentId: category.parentId,
      position: category.position,
      isActive: category.isActive,
      productCount: category._count.products,
    }));
  }

  async create(dto: CreateCategoryDto, actor: AuthenticatedUser) {
    const slug = slugify(dto.name);
    if (!slug) throw new ValidationError('El nombre de la categoría no es válido');

    const existing = await this.prisma.client.category.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (existing) throw new ConflictError(`Ya existe una categoría llamada "${dto.name}"`);

    const id = newId();
    await this.prisma.transaction(async (tx) => {
      await tx.category.create({
        data: {
          id,
          name: dto.name,
          slug,
          parentId: dto.parentId ?? null,
          position: dto.position ?? 0,
        },
      });

      await this.audit.record({
        action: 'category.create',
        entityType: 'Category',
        entityId: id,
        entityLabel: dto.name,
        userId: actor.id,
        after: { name: dto.name, slug },
      });
    });

    return this.findOne(id);
  }

  async update(id: string, dto: UpdateCategoryDto, actor: AuthenticatedUser) {
    const before = await this.prisma.client.category.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, name: true, isActive: true, parentId: true },
    });
    if (!before) throw new NotFoundError('la categoría', id);

    if (dto.parentId === id) {
      throw new ValidationError('Una categoría no puede ser su propia categoría padre');
    }

    await this.prisma.transaction(async (tx) => {
      await tx.category.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name, slug: slugify(dto.name) } : {}),
          ...(dto.parentId !== undefined ? { parentId: dto.parentId } : {}),
          ...(dto.position !== undefined ? { position: dto.position } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
      });

      await this.audit.record({
        action: 'category.update',
        entityType: 'Category',
        entityId: id,
        entityLabel: dto.name ?? before.name,
        userId: actor.id,
        before: { name: before.name, isActive: before.isActive },
        after: { name: dto.name ?? before.name, isActive: dto.isActive ?? before.isActive },
      });
    });

    return this.findOne(id);
  }

  private async findOne(id: string) {
    const category = await this.prisma.client.category.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        name: true,
        slug: true,
        parentId: true,
        position: true,
        isActive: true,
        _count: { select: { products: true } },
      },
    });
    if (!category) throw new NotFoundError('la categoría', id);

    return {
      id: category.id,
      name: category.name,
      slug: category.slug,
      parentId: category.parentId,
      position: category.position,
      isActive: category.isActive,
      productCount: category._count.products,
    };
  }
}
