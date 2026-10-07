export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message = 'Unauthorized') {
    super(401, message);
  }
}

export class ValidationError extends HttpError {
  constructor(public readonly issues: string[]) {
    super(400, 'Invalid request body');
  }
}

export class ConflictError extends HttpError {
  constructor(message: string) {
    super(409, message);
  }
}

export class NotFoundError extends HttpError {
  constructor(message: string) {
    super(404, message);
  }
}

export class TooManyRequestsError extends HttpError {
  constructor() {
    super(429, 'Too many requests');
  }
}
