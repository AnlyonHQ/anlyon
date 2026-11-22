/**
 * Pagination helpers for Anlyon Scheduler SDK
 */

import type { PaginatedResponse, Pagination } from '../types/api';

export type PageFetcher<T> = (
  page: number,
  limit: number
) => Promise<PaginatedResponse<T>>;

/**
 * Async iterator for paginating through large result sets
 */
export class PaginationIterator<T> implements AsyncIterable<T> {
  private readonly fetcher: PageFetcher<T>;
  private readonly pageSize: number;
  private currentPage: number = 1;
  private currentIndex: number = 0;
  private currentData: T[] = [];
  private pagination?: Pagination;
  private finished: boolean = false;

  constructor(fetcher: PageFetcher<T>, pageSize: number = 20) {
    this.fetcher = fetcher;
    this.pageSize = pageSize;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (!this.finished) {
      if (this.currentIndex >= this.currentData.length) {
        const response = await this.fetcher(this.currentPage, this.pageSize);

        if (!response.success || !response.data) {
          break;
        }

        this.currentData = response.data;
        this.pagination = response.pagination;
        this.currentIndex = 0;

        if (this.currentData.length === 0) {
          break;
        }
      }

      yield this.currentData[this.currentIndex++];

      if (this.currentIndex >= this.currentData.length) {
        if (!this.pagination?.hasMore) {
          this.finished = true;
        } else {
          this.currentPage++;
        }
      }
    }
  }

  /**
   * Collect all items into an array
   */
  async toArray(): Promise<T[]> {
    const items: T[] = [];
    for await (const item of this) {
      items.push(item);
    }
    return items;
  }

  /**
   * Take up to n items
   */
  async take(n: number): Promise<T[]> {
    const items: T[] = [];
    for await (const item of this) {
      items.push(item);
      if (items.length >= n) break;
    }
    return items;
  }

  /**
   * Find first item matching predicate
   */
  async find(predicate: (item: T) => boolean): Promise<T | undefined> {
    for await (const item of this) {
      if (predicate(item)) {
        return item;
      }
    }
    return undefined;
  }

  /**
   * Apply callback to each item
   */
  async forEach(callback: (item: T, index: number) => void | Promise<void>): Promise<void> {
    let index = 0;
    for await (const item of this) {
      await callback(item, index++);
    }
  }

  /**
   * Map items through a transform function
   */
  async map<U>(transform: (item: T) => U): Promise<U[]> {
    const results: U[] = [];
    for await (const item of this) {
      results.push(transform(item));
    }
    return results;
  }

  /**
   * Filter items matching predicate
   */
  async filter(predicate: (item: T) => boolean): Promise<T[]> {
    const results: T[] = [];
    for await (const item of this) {
      if (predicate(item)) {
        results.push(item);
      }
    }
    return results;
  }

  /**
   * Count all items
   */
  async count(): Promise<number> {
    let count = 0;
    for await (const _ of this) {
      count++;
    }
    return count;
  }

  /**
   * Check if any items exist
   */
  async any(): Promise<boolean> {
    for await (const _ of this) {
      return true;
    }
    return false;
  }

  /**
   * Get the first item or undefined
   */
  async first(): Promise<T | undefined> {
    for await (const item of this) {
      return item;
    }
    return undefined;
  }
}

/**
 * Helper to create a paginated fetcher that wraps a regular list method
 */
export function createPaginatedFetcher<T, P extends { page?: number; limit?: number }>(
  listFn: (params: P) => Promise<PaginatedResponse<T>>,
  baseParams?: Omit<P, 'page' | 'limit'>
): PageFetcher<T> {
  return (page: number, limit: number) =>
    listFn({ ...baseParams, page, limit } as P);
}
