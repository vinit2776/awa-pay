// Pure — no DB, no next/headers. Resolves @Full Name tokens in a posted
// comment body against a candidate list (already scope-filtered by the
// caller), longest-name-first so a shorter name can't false-match inside a
// longer one that shares a prefix (e.g. "@Anil" inside "@Anil Kumar").
export type MentionCandidate = { id: string; name: string };

export function resolveMentions(body: string, candidates: MentionCandidate[]): string[] {
  const sorted = [...candidates].sort((a, b) => b.name.length - a.name.length);
  const matched = new Set<string>();
  let masked = body;

  for (const candidate of sorted) {
    const token = `@${candidate.name}`;
    const idx = masked.toLowerCase().indexOf(token.toLowerCase());
    if (idx !== -1) {
      matched.add(candidate.id);
      // Consume the match so a shorter name sharing a prefix can't also
      // match inside the same span.
      masked = masked.slice(0, idx) + " ".repeat(token.length) + masked.slice(idx + token.length);
    }
  }

  return [...matched];
}
