import { env } from "../../config/env.ts";

export const consoleLink = (path: string) => `${env.CONSOLE_URL.replace(/\/$/, "")}${path}`;

export const absoluteActionUrl = (url: string) => (url.startsWith("/") && !url.startsWith("//") ? consoleLink(url) : url);
