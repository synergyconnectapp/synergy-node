import { SynergyError } from './errors';

/** What a page carries for the iterator: its items and the opaque cursor of the next one (`null` = the end). */
export interface PageShape<T> {
  data: T[];
  next: string | null;
}

export interface AutoPagingOptions {
  /** Most items returned: the iteration stops at it, never fetching a page it would not use. */
  limit: number;
}

/**
 * A page you can `await` (the first page) or walk (`for await`, every item of every page).
 *
 * The cursor is the server's opaque `paging.after` / `paging.before`. A short page with a non-null cursor keeps going
 * (the server stops at its scan cap, devtools.md §2.4); a cursor that repeats ends the walk instead of looping.
 * The first request is lazy and shared: `await` and `for await` on the same promise ask the server once.
 */
export class PagePromise<T, P extends { data: T[] }> implements PromiseLike<P>, AsyncIterable<T> {
  readonly #fetchPage: (cursor: string | undefined) => Promise<P>;
  readonly #nextOf: (page: P) => string | null;
  #first: Promise<P> | undefined;

  constructor(fetchPage: (cursor: string | undefined) => Promise<P>, nextOf: (page: P) => string | null) {
    this.#fetchPage = fetchPage;
    this.#nextOf = nextOf;
  }

  #firstPage(): Promise<P> {
    return (this.#first ??= this.#fetchPage(undefined));
  }

  then<R1 = P, R2 = never>(onfulfilled?: ((value: P) => R1 | PromiseLike<R1>) | null, onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null): Promise<R1 | R2> {
    return this.#firstPage().then(onfulfilled, onrejected);
  }

  catch<R = never>(onrejected?: ((reason: unknown) => R | PromiseLike<R>) | null): Promise<P | R> {
    return this.#firstPage().catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<P> {
    return this.#firstPage().finally(onfinally);
  }

  async *pages(): AsyncGenerator<P, void, undefined> {
    let page = await this.#firstPage();
    const seen = new Set<string>();
    for (;;) {
      yield page;
      const cursor = this.#nextOf(page);
      if (cursor === null || seen.has(cursor)) return;
      seen.add(cursor);
      page = await this.#fetchPage(cursor);
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T, void, undefined> {
    for await (const page of this.pages()) yield* page.data;
  }

  /** Every item, up to `limit`. The limit is required: an unbounded walk of an inbox is never what you meant. */
  async autoPagingToArray(options: AutoPagingOptions): Promise<T[]> {
    const { limit } = options ?? {};
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) throw new SynergyError('autoPagingToArray needs `limit`, a positive integer.');
    const out: T[] = [];
    for await (const item of this) {
      out.push(item);
      if (out.length >= limit) break;
    }
    return out;
  }
}
