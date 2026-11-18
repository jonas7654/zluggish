export class ApplicationError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 503,
    message = '',
  ) {
    super(message);
  }
}

/** Stored provider credentials that the credentials key cannot decrypt: another key
wrote them, or they are damaged. The rider has to enter them again.
*/
export class UnreadableCredentialsError extends Error {
  override name = 'UnreadableCredentialsError';
}

/** The provider did not complete the delivery: the request was not sent, or the
provider rejected it. Any other delivery error has an unknown remote result.
*/
export class DeliveryRefusedError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** 4xx responses reject the request; 408, 425 and 429 may follow a completed request. */
export function refused(status: number) {
  return status >= 400 && status < 500 && ![408, 425, 429].includes(status);
}

/** A failure with a safe code. Other errors record only their type name. */
export class JobError extends Error {
  constructor(
    readonly code: string,
    readonly retry = true,
  ) {
    super(code);
  }
}
