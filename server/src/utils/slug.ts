import { nanoid } from "nanoid";

export function generateSlug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function generateUniqueSlug(text: string): string {
  const baseSlug = generateSlug(text);
  const suffix = nanoid(6);
  return `${baseSlug}-${suffix}`;
}

export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9-]+$/.test(slug);
}
