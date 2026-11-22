import type { PaginatedResponse } from "../types/api.ts";

export interface PaginateOptions {
  page: number;
  limit: number;
}

export interface PaginateResult<T> {
  data: T[];
  total: number;
}

export function buildPaginatedResponse<T>(
  data: T[],
  total: number,
  page: number,
  limit: number
): PaginatedResponse<T> {
  const totalPages = Math.ceil(total / limit);
  const hasMore = page < totalPages;

  return {
    data,
    pagination: {
      total,
      page,
      limit,
      totalPages,
      hasMore,
    },
  };
}

export function getOffset(page: number, limit: number): number {
  return (page - 1) * limit;
}

export function validatePagination(page: number, limit: number): { page: number; limit: number } {
  const validPage = Math.max(1, page);
  const validLimit = Math.max(1, Math.min(100, limit));

  return { page: validPage, limit: validLimit };
}
