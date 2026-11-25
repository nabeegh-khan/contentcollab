// The drop zone: takes dropped files, cancels dragover so drop fires, and stays out of the way when it is off (D40).
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DropZone from "./DropZone.jsx";

const pdf = (name) => new File(["%PDF"], name, { type: "application/pdf" });

function mount(props = {}) {
  const onFiles = vi.fn();
  render(
    <DropZone onFiles={onFiles} {...props}>
      <input type="file" aria-label="Pick" />
    </DropZone>,
  );
  return { onFiles, zone: screen.getByRole("group", { name: /drop files/i }) };
}

const carrying = (files) => ({ dataTransfer: { files, types: ["Files"] } });

describe("DropZone", () => {
  it("hands every dropped file to the page, in order, as an array", () => {
    const { onFiles, zone } = mount();
    const files = [pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf")];
    fireEvent.drop(zone, carrying(files));
    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(onFiles.mock.calls[0][0]).toEqual(files);
    expect(Array.isArray(onFiles.mock.calls[0][0])).toBe(true);
  });

  it("cancels dragover, which the browser needs before it fires drop", () => {
    const { zone } = mount();
    // fireEvent returns false when a handler called preventDefault
    expect(fireEvent.dragOver(zone, carrying([pdf("a.pdf")]))).toBe(false);
  });

  it("cancels the drop itself, so the browser does not open the file", () => {
    const { zone } = mount();
    expect(fireEvent.drop(zone, carrying([pdf("a.pdf")]))).toBe(false);
  });

  it("marks the zone while files are dragged over it and clears the mark on leave and on drop", () => {
    const { zone } = mount();
    expect(zone.getAttribute("data-dragging")).toBe("false");
    fireEvent.dragEnter(zone, carrying([pdf("a.pdf")]));
    expect(zone.getAttribute("data-dragging")).toBe("true");
    fireEvent.dragLeave(zone, carrying([pdf("a.pdf")]));
    expect(zone.getAttribute("data-dragging")).toBe("false");
    fireEvent.dragEnter(zone, carrying([pdf("a.pdf")]));
    fireEvent.drop(zone, carrying([pdf("a.pdf")]));
    expect(zone.getAttribute("data-dragging")).toBe("false");
  });

  it("ignores a drop with no files, such as dragged text", () => {
    const { onFiles, zone } = mount();
    fireEvent.drop(zone, { dataTransfer: { files: [], types: ["text/plain"] } });
    expect(onFiles).not.toHaveBeenCalled();
  });

  it("takes nothing while it is disabled, for example during an upload", () => {
    const { onFiles, zone } = mount({ disabled: true });
    fireEvent.drop(zone, carrying([pdf("a.pdf")]));
    expect(onFiles).not.toHaveBeenCalled();
    expect(zone.getAttribute("aria-disabled")).toBe("true");
  });

  it("keeps the picker inside it", () => {
    mount();
    expect(screen.getByLabelText("Pick")).toBeTruthy();
  });

  it("says in words that files can be dropped, for a reader who does not see the dashed frame", () => {
    mount();
    expect(screen.getByText(/drop files here/i)).toBeTruthy();
  });
});
