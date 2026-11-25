// The one-line outcome of a batch of uploads, for one toast per drop or pick (D40).
export function summarizeBatch(items) {
  const done = items.filter((item) => item.status === "done").length;
  const failed = items.length - done;

  if (failed === 0) {
    return {
      kind: "success",
      text: items.length === 1 ? `${items[0].name} uploaded.` : `${done} files uploaded.`,
    };
  }
  if (items.length === 1) {
    return { kind: "error", text: `${items[0].name} was not uploaded: ${items[0].message}` };
  }
  if (done === 0) {
    return { kind: "error", text: `None of the ${items.length} files were uploaded.` };
  }
  return { kind: "error", text: `${done} uploaded, ${failed} failed.` };
}
