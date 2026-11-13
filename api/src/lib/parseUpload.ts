import Busboy from "busboy";
import type { Request } from "express";
import type { Readable } from "node:stream";
import { extname } from "node:path";
import { HttpError } from "./httpError.js";

const MAX_FILE_SIZE = 50 * 1024 * 1024;

const allowedTypes: Record<string, string[]> = {
  ".pdf": ["application/pdf"],
  ".png": ["image/png"],
  ".jpg": ["image/jpeg"],
  ".jpeg": ["image/jpeg"],
  ".docx": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ".xlsx": ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ".pptx": ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ".txt": ["text/plain"],
  ".md": ["text/markdown", "text/plain"],
};

export type UploadInfo = {
  filename: string;
  contentType: string;
};

export type ParsedUpload = UploadInfo & {
  title?: string;
};

export function parseUpload(
  req: Request,
  onFile: (file: Readable, info: UploadInfo, signal: AbortSignal) => Promise<void>,
): Promise<ParsedUpload> {
  return new Promise((resolve, reject) => {
    let busboy: ReturnType<typeof Busboy>;

    try {
      busboy = Busboy({
        headers: req.headers,
        limits: {
          fileSize: MAX_FILE_SIZE,
          files: 1,
          fields: 1,
          parts: 2,
          fieldSize: 1024,
        },
      });
    } catch {
      reject(new HttpError(400, "VALIDATION", "Invalid Multipart Request"));
      return;
    }

    const controller = new AbortController();
    let title: string | undefined;
    let uploadInfo: UploadInfo | undefined;
    let uploadPromise: Promise<void> | undefined;
    let failure: Error | undefined;

    busboy.on("field", (name, value, info) => {
      if (name !== "title" || info.valueTruncated) {
        failure ??= new HttpError(400, "VALIDATION", "Invalid Upload Field");
        return;
      }
      title = value;
    });

    busboy.on("file", (name, file, info) => {
      if (name !== "file" || !info.filename) {
        failure ??= new HttpError(400, "VALIDATION", "File Required");
        file.resume();
        return;
      }

      const extension = extname(info.filename).toLowerCase();
      if (!allowedTypes[extension]?.includes(info.mimeType)) {
        failure ??= new HttpError(400, "VALIDATION", "File Type Not Allowed");
        file.resume();
        return;
      }

      uploadInfo = {
        filename: info.filename,
        contentType: info.mimeType,
      };

      file.on("limit", () => {
        failure = new HttpError(413, "TOO_LARGE", "File Too Large");
        controller.abort();
        file.resume();
      });

      uploadPromise = onFile(file, uploadInfo, controller.signal).catch((error: unknown) => {
        failure ??= error instanceof Error ? error : new Error(String(error));
        file.resume();
      });
    });

    busboy.on("filesLimit", () => {
      failure ??= new HttpError(400, "VALIDATION", "Only One File Is Allowed");
    });

    busboy.on("fieldsLimit", () => {
      failure ??= new HttpError(400, "VALIDATION", "Too Many Fields");
    });

    busboy.on("partsLimit", () => {
      failure ??= new HttpError(400, "VALIDATION", "Too Many Parts");
    });

    busboy.on("error", reject);

    busboy.on("close", () => {
      void (async () => {
        await uploadPromise;
        if (failure) throw failure;
        if (!uploadInfo) {
          throw new HttpError(400, "VALIDATION", "File Required");
        }
        resolve({
          ...uploadInfo,
          ...(title !== undefined ? { title } : {}),
        });
      })().catch(reject);
    });

    req.pipe(busboy);
  });
}
