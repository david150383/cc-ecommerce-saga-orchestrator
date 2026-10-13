// RFC 9457 Problem Details. Every error response in the platform has this shape.
// See ecommerce-infrastructure/docs/architecture/conventions.md#error-responses-rfc-9457-problem-details

export interface FieldError {
  path: string;
  message: string;
}

export class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly detail?: string,
    readonly errors?: FieldError[],
  ) {
    super(title);
    this.name = "HttpProblem";
  }
}

export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  instance: string;
  correlationId?: string;
  errors?: FieldError[];
}

export function toProblemBody(problem: HttpProblem, instance: string, correlationId?: string): ProblemBody {
  return {
    type: `https://errors.ecommerce.local/${problem.code.toLowerCase().replaceAll("_", "-")}`,
    title: problem.title,
    status: problem.status,
    code: problem.code,
    ...(problem.detail !== undefined && { detail: problem.detail }),
    instance,
    ...(correlationId !== undefined && { correlationId }),
    ...(problem.errors !== undefined && { errors: problem.errors }),
  };
}
