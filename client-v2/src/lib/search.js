// Free-text search shared by the views.
//
// Terms are AND-ed rather than matched as one substring, so typing more words
// narrows the result instead of killing it: "hunter lidar" finds the Hunter
// Valley job whose description mentions LiDAR, even though that exact string
// appears nowhere. Order does not matter either, which is what people expect
// when they half-remember a name.

export function normalise(value) {
  return String(value ?? '').toLowerCase().trim();
}

/**
 * Build a predicate for a query. Call the result with the fields to search:
 *
 *   const match = makeMatcher(query);
 *   jobs.filter((j) => match(j.code, j.name, j.client));
 *
 * An empty query matches everything, so callers need no special case.
 */
export function makeMatcher(query) {
  const terms = normalise(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return () => true;
  return (...fields) => {
    const haystack = fields.map(normalise).join(' ');
    return terms.every((term) => haystack.includes(term));
  };
}
