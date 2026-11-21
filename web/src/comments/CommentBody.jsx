// A comment's body as React text nodes, with each @mention in bold: never HTML (SEC-7).
import { splitMentions } from "./thread.js";

export default function CommentBody({ body }) {
  return (
    <p className="comment-body">
      {splitMentions(body).map((part, index) =>
        part.type === "mention" ? (
          <strong key={index} className="mention">
            {part.text}
          </strong>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </p>
  );
}
