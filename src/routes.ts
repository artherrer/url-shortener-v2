/**
 * Fixed routes of the app. The router's table must have exactly these keys (enforced by its type),
 * and every non-root path here is reserved, so a route can never be shadowed by an alias.
 */
export const ROUTE_PATHS = ['/', '/links'] as const;

export type RoutePath = (typeof ROUTE_PATHS)[number];
