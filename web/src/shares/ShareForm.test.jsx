// Render tests for the share form: success, each refusal the API gives, and empty fields.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ShareForm from "./ShareForm.jsx";

const DOC = "11111111-1111-4111-8111-111111111111";

function answer(status, body) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function fill({ doc = DOC, email = "bo@x.co", role } = {}) {
  fireEvent.change(screen.getByLabelText("Document id"), { target: { value: doc } });
  fireEvent.change(screen.getByLabelText("Email of the user"), { target: { value: email } });
  if (role) fireEvent.change(screen.getByLabelText("Role"), { target: { value: role } });
  fireEvent.click(screen.getByRole("button", { name: "Share" }));
}

describe("ShareForm", () => {
  it("offers editor, commenter and viewer, with viewer first", () => {
    render(<ShareForm token="t0k" />);

    const options = [...screen.getByLabelText("Role").querySelectorAll("option")];
    expect(options.map((o) => o.value)).toEqual(["viewer", "commenter", "editor"]);
    expect(screen.getByLabelText("Role").value).toBe("viewer");
  });

  it("shares with the trimmed email and chosen role, and says so", async () => {
    const fetchMock = answer(201, { id: "s1", role: "commenter" });
    render(<ShareForm token="t0k" />);

    fill({ email: " bo@x.co ", role: "commenter" });

    expect(await screen.findByText("Shared with bo@x.co as commenter.")).toBeTruthy();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/v1/documents/${DOC}/shares`);
    expect(JSON.parse(init.body)).toEqual({ email: "bo@x.co", role: "commenter" });
    expect(init.headers.Authorization).toBe("Bearer t0k");
  });

  it("says no user has that email on a 404", async () => {
    answer(404, { error: "User Not Found", code: "NOT_FOUND" });
    render(<ShareForm token="t0k" />);

    fill();

    expect((await screen.findByRole("alert")).textContent).toBe(
      "No user has that email, or you have no access to this document.",
    );
  });

  it("says the user already has a share on a 409", async () => {
    answer(409, { error: "User Already Shared", code: "CONFLICT" });
    render(<ShareForm token="t0k" />);

    fill();

    expect((await screen.findByRole("alert")).textContent).toMatch(/already/i);
  });

  it("says only the owner can share on a 403", async () => {
    answer(403, { error: "Forbidden", code: "FORBIDDEN" });
    render(<ShareForm token="t0k" />);

    fill();

    expect((await screen.findByRole("alert")).textContent).toMatch(/owner/i);
  });

  it("calls nothing and asks for both fields when one is empty", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<ShareForm token="t0k" />);

    fill({ email: "" });

    expect(screen.getByRole("alert").textContent).toMatch(/document id and an email/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clears an old message when sharing again", async () => {
    answer(409, { error: "x", code: "CONFLICT" });
    render(<ShareForm token="t0k" />);
    fill();
    await screen.findByRole("alert");

    answer(201, { id: "s2", role: "viewer" });
    fireEvent.click(screen.getByRole("button", { name: "Share" }));

    expect(await screen.findByText("Shared with bo@x.co as viewer.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("tells the user to sign in again on a 401", async () => {
    answer(401, { error: "Unauthorized", code: "UNAUTHORIZED" });
    render(<ShareForm token="t0k" />);

    fill();

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Your session has ended. Sign out and sign in again.",
    );
  });

  it("shows a plain message when the request cannot be sent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    render(<ShareForm token="t0k" />);

    fill();

    expect((await screen.findByRole("alert")).textContent).toBe("Something went wrong. Try again.");
  });

  it("disables the button while the request is out", async () => {
    let release;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            release = () =>
              resolve(
                new Response(JSON.stringify({ id: "s1" }), {
                  status: 201,
                  headers: { "Content-Type": "application/json" },
                }),
              );
          }),
      ),
    );
    render(<ShareForm token="t0k" />);

    fill();

    expect(screen.getByRole("button", { name: "Share" }).disabled).toBe(true);
    release();
    await screen.findByText("Shared with bo@x.co as viewer.");
    expect(screen.getByRole("button", { name: "Share" }).disabled).toBe(false);
  });

  it("clears the success message when a field is edited", async () => {
    answer(201, { id: "s1" });
    render(<ShareForm token="t0k" />);
    fill();
    await screen.findByText("Shared with bo@x.co as viewer.");

    fireEvent.change(screen.getByLabelText("Email of the user"), { target: { value: "c@x.co" } });

    expect(screen.queryByText("Shared with bo@x.co as viewer.")).toBeNull();
  });
});
