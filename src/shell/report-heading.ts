// The heading of a report: its name as the menus write it, then the object it is about after a colon
// (`Schema History: shop.orders`, `Activity: shop`); a report of the whole lake has its name alone.

/** `name` alone, or `name: object`. */
export function reportHeading(name: string, object?: string): string {
  return object === undefined || object === '' ? name : `${name}: ${object}`;
}
