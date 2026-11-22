import { useCallback, useState, type SVGProps } from 'react';

/** Every component takes these. */
export interface StyleProps {
  /** Added to the component's root element. */
  className?: string;
  /**
   * Drop the bundled styles: the root loses the `anlyon` class that `styles.css` keys on. The
   * `anlyon-*` class names and `data-state` attributes stay, for your own CSS.
   */
  unstyled?: boolean;
}

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/** The root element's class: the theme root `anlyon` unless unstyled, the component's own, the caller's. */
export function rootClass(name: string, { className, unstyled }: StyleProps): string {
  return cx(!unstyled && 'anlyon', name, className);
}

/** Two letters for an integration with no logo: `GitHub` → `GH`, `Slack` → `Sl`. */
export function monogram(name: string): string {
  const capitals = name.replace(/[^A-Za-z0-9 ]/g, '').match(/\b[A-Za-z0-9]|[A-Z]/g) ?? [];
  if (capitals.length >= 2) return (capitals[0] + capitals[1]).toUpperCase();
  const word = name.replace(/[^A-Za-z0-9]/g, '');
  return word.slice(0, 2).replace(/^./, (c) => c.toUpperCase()) || '?';
}

/** A polite live region's text, set again for each announcement. */
export function useAnnouncer(): [string, (message: string) => void] {
  const [message, setMessage] = useState('');
  const announce = useCallback((next: string) => {
    setMessage('');
    setTimeout(() => setMessage(next), 50);
  }, []);
  return [message, announce];
}

export function LiveRegion({ message }: { message: string }) {
  return (
    <div className="anlyon-sr-only" role="status" aria-live="polite" aria-atomic="true">
      {message}
    </div>
  );
}

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps) {
  return (
    <svg
      className="anlyon-icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export const CheckIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3.5 8.5l3 3 6-7" />
  </Icon>
);

export const XIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
  </Icon>
);

export const ClockIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="8" cy="8" r="5.75" />
    <path d="M8 5v3.25l2 1.25" />
  </Icon>
);

export const AlertIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="8" cy="8" r="5.75" />
    <path d="M8 5v3.5M8 10.75v.01" />
  </Icon>
);

export const ChevronIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M6 4l4 4-4 4" />
  </Icon>
);

export const ExternalIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M9.5 3.5h3v3M12.5 3.5L7 9M11 9.5v3H3.5V5H6.5" />
  </Icon>
);

export function Spinner() {
  return (
    <svg className="anlyon-spinner" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** Placeholder rows while the first read runs. */
export function SkeletonRows({ count = 3 }: { count?: number }) {
  return (
    <ul className="anlyon-list" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="anlyon-skeleton-row">
          <span className="anlyon-skeleton" data-size="avatar" />
          <span className="anlyon-skeleton-lines">
            <span className="anlyon-skeleton" data-size="title" />
            <span className="anlyon-skeleton" data-size="line" />
          </span>
        </li>
      ))}
    </ul>
  );
}
