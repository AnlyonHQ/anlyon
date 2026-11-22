export const ACTING_FOR = ["team", "users", "both"] as const;
export type ActingFor = (typeof ACTING_FOR)[number];

export const DECIDERS = ["team", "end_user"] as const;
export type Decider = (typeof DECIDERS)[number];

export const SETUP_STATUSES = ["completed", "skipped"] as const;
export type SetupStatus = (typeof SETUP_STATUSES)[number];

export const DEFAULTS_SOURCES = ["setup_journey", "defaults_page", "home_prompt"] as const;
export type DefaultsSource = (typeof DEFAULTS_SOURCES)[number];

export const MIN_APPROVAL_WINDOW_HOURS = 1;
export const MAX_APPROVAL_WINDOW_HOURS = 168;

export const RECOMMENDED_ACTING_FOR: ActingFor = "both";

export const RECOMMENDED_DECIDER: Decider = "team";
