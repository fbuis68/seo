import { NextFunction, Request, Response } from "express";

type Handler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/** Wraps an async Express handler so rejected promises reach the error middleware. */
export function asyncHandler(fn: Handler) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
