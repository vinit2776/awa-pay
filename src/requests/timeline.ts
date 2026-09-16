// The trail, the comments and the queries are three tables but one story:
// what happened to this request, in order. Merging them is pure so the
// ordering rules are testable without a database — the page does the
// scoped reads, this decides what the reader sees.

export type TimelineEvent = { kind: "event"; id: string; at: string; actorName: string; icon: string; label: string; detail: string };
export type TimelineComment = {
  kind: "comment";
  id: string;
  at: string;
  authorName: string;
  roleAtTime: string;
  body: string;
  attachments: { id: string; mime: string; downloadUrl: string }[];
};
export type TimelineQuery = {
  kind: "query";
  id: string;
  at: string;
  raisedByName: string;
  question: string;
  directedAt: string[];
  answer: string | null;
  answeredByName: string | null;
  resolvedAt: string | null;
};
export type TimelineEntry = TimelineEvent | TimelineComment | TimelineQuery;

// Oldest first, the way the trail already reads. Ties break by kind so a
// transition and the comment that explains it never swap places between
// renders: the event that moved the request comes first, then the query
// it raised, then the comment about it.
const KIND_ORDER: Record<TimelineEntry["kind"], number> = { event: 0, query: 1, comment: 2 };

export function mergeTimeline(entries: TimelineEntry[]): TimelineEntry[] {
  return [...entries].sort((a, b) => {
    const byTime = Date.parse(a.at) - Date.parse(b.at);
    if (byTime !== 0) return byTime;
    return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  });
}

// A query freezes the request where it stands (AGENTS.md: "a query is
// none of those — it freezes the request in place"), so an unresolved one
// is what the desk panel and the banner both key off.
export function openQueries(entries: TimelineEntry[]): TimelineQuery[] {
  return entries.filter((e): e is TimelineQuery => e.kind === "query" && e.resolvedAt === null);
}

// Whose answer is being waited on, in words, for the banner.
export function freezeReason(queries: TimelineQuery[]): string | null {
  if (queries.length === 0) return null;
  const [first] = queries;
  const who = first.directedAt.join(" or ").replace(/_/g, " ");
  return `${first.raisedByName} asked the ${who}: “${first.question}”`;
}
