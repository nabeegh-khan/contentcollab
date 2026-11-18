export type ValidationDetail = {
  field: string;
  message: string;
};

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: ValidationDetail[],
  ) {
    super(message);
    this.name = "HttpError";
  }
}
