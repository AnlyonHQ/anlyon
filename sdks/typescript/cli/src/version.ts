export const CLI_VERSION: string = __ANLYON_CLI_VERSION__;
export const SDK_VERSION: string = __ANLYON_SDK_VERSION__;

export function runtimeDescription(): string {
  const bun = (process.versions as Record<string, string | undefined>).bun;
  return bun ? `bun ${bun}` : `node ${process.versions.node}`;
}
