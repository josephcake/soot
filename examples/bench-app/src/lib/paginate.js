/**
 * Return page `page` (1-based) of `items`, `size` items per page, plus the total page count.
 */
export function paginate(items, page, size) {
  const pages = Math.floor(items.length / size);
  const start = page * size;
  return { items: items.slice(start, start + size), page, pages };
}
