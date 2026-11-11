// HTTP status codes the API and its tests refer to, named once.
export const HTTP_OK = 200;
export const HTTP_CREATED = 201;
export const HTTP_BAD_REQUEST = 400;
export const HTTP_NOT_FOUND = 404;
export const HTTP_PAYLOAD_TOO_LARGE = 413;
export const HTTP_UNPROCESSABLE = 422;
export const HTTP_INTERNAL_ERROR = 500;
export const HTTP_UNAVAILABLE = 503;

// The first status that is a client error, and the first that is a server
// error: a status class is its code divided by this hundred.
export const HTTP_CLIENT_ERROR_MIN = HTTP_BAD_REQUEST;
export const HTTP_SERVER_ERROR_MIN = HTTP_INTERNAL_ERROR;
export const HTTP_CLASS_SIZE = 100;
