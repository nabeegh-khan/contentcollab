// Pure comment helpers: apply a live event to the list, group replies under roots, find mentions (D28).
const MENTION = /@[\w.-]+/g; // the same pattern the API uses to find mentions

// Every comment under `rootId`, at any depth
function descendantIds(list, rootId) {
  const ids = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const comment of list) {
      if (comment.parentId && ids.has(comment.parentId) && !ids.has(comment.id)) {
        ids.add(comment.id);
        grew = true;
      }
    }
  }
  return ids;
}

function upsert(list, comment) {
  const index = list.findIndex((existing) => existing.id === comment.id);
  if (index === -1) return [...list, comment];
  return list.map((existing, i) => (i === index ? comment : existing));
}

// A resolve is stored on the thread root and the API reports it on every comment of the thread
function spreadResolved(list, root) {
  const ids = descendantIds(list, root.id);
  return list.map((comment) =>
    ids.has(comment.id) ? { ...comment, resolved: root.resolved } : comment,
  );
}

// Returns the new list for a socket event; never changes the list it was given
export function applyEvent(list, event, payload) {
  if (event === "comment:created") return upsert(list, payload);
  if (event === "comment:updated") {
    const next = upsert(list, payload);
    return payload.parentId ? next : spreadResolved(next, payload);
  }
  if (event === "comment:deleted") {
    const gone = descendantIds(list, payload.id);
    if (!list.some((comment) => comment.id === payload.id)) return list;
    return list.filter((comment) => !gone.has(comment.id));
  }
  return list;
}

// Roots in order, each with every reply under it in order; a reply whose parent is missing is a root
export function buildThreads(list) {
  const known = new Set(list.map((comment) => comment.id));
  const roots = list.filter((comment) => !comment.parentId || !known.has(comment.parentId));
  return roots.map((root) => {
    const ids = descendantIds(list, root.id);
    return { root, replies: list.filter((c) => ids.has(c.id) && c.id !== root.id) };
  });
}

// Splits a body into plain and @mention parts, to be rendered as text (SEC-7)
export function splitMentions(body) {
  const parts = [];
  let last = 0;
  for (const match of body.matchAll(MENTION)) {
    if (match.index > last) parts.push({ type: "text", text: body.slice(last, match.index) });
    parts.push({ type: "mention", text: match[0] });
    last = match.index + match[0].length;
  }
  if (last < body.length) parts.push({ type: "text", text: body.slice(last) });
  return parts;
}

// "You" for the signed-in user, else the author's display name when the API sends it (authorDisplayName),
// else a short id. A blank name counts as no name.
export function authorLabel(authorId, currentUserId, displayName) {
  if (authorId && authorId === currentUserId) return "You";
  const name = typeof displayName === "string" ? displayName.trim() : "";
  if (name) return name;
  return authorId ? `Member ${authorId.slice(0, 8)}` : "Member";
}
