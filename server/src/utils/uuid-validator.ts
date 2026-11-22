import { z } from "zod";
import { ValidationError } from "./errors.ts";

const uuidSchema = z.string().guid();

export function validateUUID(id: string | undefined | null, fieldName: string = "ID"): string {
  if (!id) {
    throw new ValidationError(`${fieldName} is required`);
  }

  try {
    return uuidSchema.parse(id);
  } catch (error) {
    throw new ValidationError(`Invalid ${fieldName} format`);
  }
}

export function isValidUUID(id: string | undefined | null): boolean {
  if (!id) return false;
  return uuidSchema.safeParse(id).success;
}
