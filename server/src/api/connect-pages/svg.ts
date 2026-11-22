export function inlineSvg(source: string): string {
  const svg = source
    .replace(/<\?xml[^>]*>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<title>[\s\S]*?<\/title>/g, "")
    .replace(/\s+/g, " ")
    .replace(/>\s+</g, "><")
    .trim();
  return svg.replace(/^<svg\b([^>]*)>/, (_, attributes: string) => {
    const kept = attributes
      .replace(/\s(width|height|role|aria-label|aria-hidden|focusable)="[^"]*"/g, "")
      .trim();
    return `<svg ${kept} aria-hidden="true" focusable="false">`;
  });
}

export function isInertSvg(svg: string): boolean {
  return !/<script|<foreignObject|\son[a-z]+\s*=|(?:xlink:)?href\s*=\s*"(?!#)|url\((?!#)|@import|<image/i.test(svg);
}
